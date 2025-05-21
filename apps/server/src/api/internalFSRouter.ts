// src/api/internalFSRouter.ts
import express, { Router, Request, Response } from 'express';
import path from 'node:path';
import prisma from '@codeyarn/db';
import { FileSystemNode } from '@codeyarn/shared-types'; // Assuming this type is available
import { findFullContainerId } from '../services/containerService';
import { io } from '../socket/ioServer'; // For broadcasting updates

const router = Router();

router.post('/internal/filesystem-event', async (req: Request, res: Response) => {
    const eventData = req.body;
    console.log('[API Internal] Received FS Event:', JSON.stringify(eventData));

    const { containerId: shortContainerId, event, type, path: rawEventPath } = eventData;

    if (!shortContainerId || !event || !type || !rawEventPath || typeof rawEventPath !== 'string') {
        console.warn('[API Internal] Invalid FS event received:', eventData);
        return res.status(400).send('Invalid event data');
    }

    let dbPath = rawEventPath;
    if (dbPath.startsWith('/workspace')) {
        dbPath = dbPath.substring('/workspace'.length);
        if (dbPath === '') dbPath = '/';
    }
    if (dbPath !== '/' && !dbPath.startsWith('/')) {
        dbPath = '/' + dbPath;
    }
    console.log(`[API Internal] Watcher path: "${rawEventPath}", 
        Normalized DB path: "${dbPath}"`);

    const fullContainerId = await findFullContainerId(shortContainerId);

    if (!fullContainerId) {
        console.error(`[API Internal] Full container ID not found for short ID: ${shortContainerId}. 
            Cannot process event for path: ${dbPath}.`);
        return res.status(204).send();
    }

    try {
        const containerRecord = await prisma.container.findUnique({
            where: { id: fullContainerId },
            select: { projectId: true }
        });

        if (!containerRecord) {
            console.error(`[API Internal] Container DB record not found for full ID: ${fullContainerId}. 
                Cannot process event for path: ${dbPath}.`);
            return res.status(404).send('Container record not found in DB');
        }
        const projectId = containerRecord.projectId;
        let fileSystemNodeForBroadcast: FileSystemNode | null = null;

        if (event === 'create') {
            const name = path.basename(dbPath);
            let parentDbPath = path.dirname(dbPath).replace(/\\/g, '/');
            if (parentDbPath === '.') parentDbPath = '/';
            
            const isDirectory = type === 'directory';
            let parentId: string | null = null;

            if (parentDbPath !== '/') {
                const parentNode = await prisma.file.findUnique({
                    where: { projectId_path: { projectId, path: parentDbPath } },
                    select: { id: true, isDirectory: true }
                });
                if (parentNode && parentNode.isDirectory) {
                    parentId = parentNode.id;
                } else {
                     console.warn(`[API Internal] Parent node at DB path "${parentDbPath}" not found 
                        or not a directory for creating "${dbPath}".`);
                     // Attempt to find a root node if one is conventional (e.g. path: '/')
                     const rootNode = await prisma.file.findFirst({
                         where: { projectId, parentId: null, path: '/' } // Or your convention for root
                     });
                     if (rootNode) parentId = rootNode.id;
                }
            } else { // Direct child of root, find the root node if it exists by convention
                 const rootNode = await prisma.file.findFirst({
                     where: { projectId, parentId: null, path: '/' } // Or your convention for root
                 });
                 if (rootNode) parentId = rootNode.id;
            }

            const existingNode = await prisma.file.findUnique({
                where: { projectId_path: { projectId, path: dbPath } }
            });

            if (existingNode) {
                console.warn(`[API Internal] Node ${dbPath} (event: create) 
                    reported by watcher already exists in DB. Updating timestamp.`);
                const updatedNode = await prisma.file.update({
                    where: { id: existingNode.id },
                    data: { 
                        updatedAt: new Date(), 
                        content: isDirectory ? null : null, 
                        isDirectory: isDirectory 
                    }
                });
                fileSystemNodeForBroadcast = { 
                    ...updatedNode, 
                    createdAt: updatedNode.createdAt.toISOString(), 
                    updatedAt: updatedNode.updatedAt.toISOString(), 
                    content: updatedNode.content ?? undefined 
                };
            } else {
                const newNode = await prisma.file.create({
                    data: { 
                        name, 
                        path: dbPath, 
                        isDirectory, 
                        projectId, 
                        parentId, 
                        content: isDirectory ? null : null 
                    }
                });
                console.log(`[API Internal] Created DB record for ${dbPath} (ID: ${newNode.id})`);
                fileSystemNodeForBroadcast = { 
                    ...newNode, 
                    createdAt: newNode.createdAt.toISOString(), 
                    updatedAt: newNode.updatedAt.toISOString(), 
                    content: newNode.content ?? undefined 
                };
            }
        } else if (event === 'delete') {
            const nodeToDelete = await prisma.file.findUnique({
                where: { projectId_path: { 
                    projectId, 
                    path: dbPath 
                } },
                select: { id: true, isDirectory: true }
            });

            if (nodeToDelete) {
                const idsToDelete: string[] = [nodeToDelete.id];
                if (nodeToDelete.isDirectory) {
                    const queue = [nodeToDelete.id];
                    while (queue.length > 0) {
                        const currentParentId = queue.shift()!;
                        const children = await prisma.file.findMany({
                            where: { parentId: currentParentId },
                            select: { id: true, isDirectory: true }
                        });
                        children.forEach((child: any) => {
                            idsToDelete.push(child.id);
                            if (child.isDirectory) queue.push(child.id);
                        });
                    }
                }
                const deleteResult = await prisma.file.deleteMany({ 
                    where: { id: { in: idsToDelete } } 
                });
                console.log(`[API Internal] Deleted ${deleteResult.count} 
                    DB record(s) for path ${dbPath}`);
            } else {
                 console.warn(`[API Internal] Node ${dbPath} not found in DB for delete event.`);
            }
        } else if (event === 'modify') {
            const nodeToUpdate = await prisma.file.findUnique({
                where: { projectId_path: { 
                    projectId, 
                    path: dbPath 
                } },
                select: { id: true, isDirectory: true }
            });
            if (nodeToUpdate) {
                if (nodeToUpdate.isDirectory) {
                    await prisma.file.update({ 
                        where: { id: nodeToUpdate.id }, 
                        data: { updatedAt: new Date() } 
                    });
                } else {
                    await prisma.file.update({
                        where: { id: nodeToUpdate.id },
                        data: { 
                            updatedAt: new Date(), 
                            content: null 
                        } // Nullify content to force reload
                    });
                }
                console.log(`[API Internal] Updated timestamp for modified item: ${dbPath}`);
            } else {
                console.warn(`[API Internal] Node ${dbPath} not found for modify event.`);
            }
        } else {
            console.warn(`[API Internal] Received unhandled event type: ${event} for path ${dbPath}`);
        }

        if (io && (event === 'create' || event === 'delete' || event === 'modify')) {
            io.to(fullContainerId).emit('fs-update', {
                containerId: fullContainerId,
                event,
                type,
                path: dbPath,
                ...(event === 'create' && 
                    fileSystemNodeForBroadcast && 
                    { node: fileSystemNodeForBroadcast }),
            });
            console.log(`[API Internal] Broadcasted 'fs-update' to room: ${fullContainerId} 
                for event: ${event}, path: ${dbPath}`);
        }
        res.status(204).send();

    } catch (error: any) {
        console.error(`[API Internal Error] Failed to process FS event for container ${shortContainerId} 
            (full: ${fullContainerId}), raw path ${rawEventPath} (DB path ${dbPath}):`, error);
        res.status(500).send('Internal Server Error');
    }
});

export const internalFSRouter: Router = router;
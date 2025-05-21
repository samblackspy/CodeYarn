// src/socket/fileSystemHandler.ts
import { Socket } from 'socket.io';
import prisma from '@codeyarn/db';
import { buildTreeFromFlatList, PrismaFileNode, FileStructureNode } from '../lib/utils'; // Adjust path if utils.ts is elsewhere

export async function handleGetInitialFileSystem(socket: Socket, containerId: string) {
    console.log(`[Socket.IO] Received get-initial-fs for ${containerId} from ${socket.id}`);
    try {
        const containerRecord = await prisma.container.findUnique({
            where: { id: containerId },
            select: { projectId: true }
        });
        if (!containerRecord) throw new Error(`Container record not found: ${containerId}`);
        const projectId = containerRecord.projectId;

        const fileNodesFromDb = await prisma.file.findMany({
            where: { projectId: projectId },
            select: {
                id: true, name: true, path: true, projectId: true, parentId: true,
                isDirectory: true, createdAt: true, updatedAt: true,
            },
            orderBy: { path: 'asc' }
        });

        const fileTree = buildTreeFromFlatList(fileNodesFromDb as PrismaFileNode[], projectId);

        console.log(`[Socket.IO] Sending initial-fs for project ${projectId} to ${socket.id}`);
        socket.emit('initial-fs', {
            containerId: containerId,
            projectId: projectId,
            fileStructure: fileTree
        });
    } catch (error: any) {
        console.error(`[Socket.IO Error] Failed to get initial FS for container ${containerId} from ${socket.id}:`, error);
        socket.emit('fs-error', {
            containerId: containerId,
            error: 'Failed to load file structure'
        });
    }
}
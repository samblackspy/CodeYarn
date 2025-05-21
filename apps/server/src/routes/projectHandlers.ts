// src/routes/projectHandlers.ts
import { Request, Response, NextFunction } from 'express';
import prisma from '@codeyarn/db';
import { buildTreeFromFlatList, PrismaFileNode } from '../lib/utils';
import { getContainerSafely } from '../services/dockerService';

export async function getProjectFilesHandler(req: Request, res: Response, next: NextFunction) {
    const { projectId } = req.params;
    if (typeof projectId !== 'string' || !projectId) {
        return res.status(400).json({ message: 'Invalid project ID provided' });
    }
    console.log(`[API Projects] Request received for file tree of project: ${projectId}`);

    try {
        const projectExists = await prisma.project.findUnique({
            where: { id: projectId },
            select: { id: true }
        });
        if (!projectExists) {
            return res.status(404).json({ message: 'Project not found' });
        }

        const fileNodesFromDb = await prisma.file.findMany({
            where: { projectId: projectId },
            select: {
                id: true, name: true, path: true, projectId: true, parentId: true,
                isDirectory: true, createdAt: true, updatedAt: true,
            },
            orderBy: { path: 'asc' }
        });

        const fileTree = buildTreeFromFlatList(fileNodesFromDb as PrismaFileNode[], projectId);

        console.log(`[API Projects] Sending file tree for project: ${projectId}`);
        res.status(200).json({
            containerId: null,
            projectId: projectId,
            fileStructure: fileTree
        });
    } catch (error: any) {
        console.error(`[API Error] Failed to get file tree for project ${projectId}:`, error);
        next(error);
    }
}

export async function createProjectHandler(req: Request, res: Response, next: NextFunction) {
    const { name, templateId, description } = req.body;
    const ownerId = 'clerk-user-placeholder'; // Placeholder

    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ message: 'Missing or invalid project name' });
    }
    if (!templateId || typeof templateId !== 'string') {
        return res.status(400).json({ message: 'Missing or invalid templateId' });
    }
    if (description && typeof description !== 'string') {
        return res.status(400).json({ message: 'Invalid description format' });
    }

    console.log(`[API Projects] Request to create project "${name}" with template ${templateId}`);

    try {
        const newProject = await prisma.project.create({
            data: {
                name: name.trim(),
                templateId: templateId,
                ownerId: ownerId,
                description: description?.trim() || null,
            }
        });
        console.log(`[API Projects] Created project ${newProject.id}`);

        const responseData = {
            ...newProject,
            createdAt: newProject.createdAt.toISOString(),
            updatedAt: newProject.updatedAt.toISOString(),
            lastAccessedAt: newProject.lastAccessedAt?.toISOString() ?? null,
        };
        res.status(201).json(responseData);
    } catch (error: any) {
        console.error(`[API Error] Failed to create project "${name}":`, error);
        if (error.code === 'P2003') {
            return res.status(400).json({ message: `Invalid templateId: ${templateId}` });
        }
        next(error);
    }
}

export async function listProjectsHandler(req: Request, res: Response, next: NextFunction) {
    const ownerId = 'clerk-user-placeholder'; // Placeholder
    console.log(`[API Projects] Request to list projects for owner ${ownerId}`);

    try {
        const projects = await prisma.project.findMany({
            where: { ownerId: ownerId },
            orderBy: { updatedAt: 'desc' },
        });

        const responseData = projects.map(p => ({
            ...p,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
            lastAccessedAt: p.lastAccessedAt?.toISOString() ?? null,
        }));
        res.status(200).json(responseData);
    } catch (error: any) {
        console.error(`[API Error] Failed to list projects for owner ${ownerId}:`, error);
        next(error);
    }
}

export async function getProjectDetailsHandler(req: Request, res: Response, next: NextFunction) {
    const { projectId } = req.params;
    if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ message: 'Invalid project ID' });
    console.log(`[API Projects] Request to get details for project ${projectId}`);

    try {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        const responseData = {
            ...project,
            createdAt: project.createdAt.toISOString(),
            updatedAt: project.updatedAt.toISOString(),
            lastAccessedAt: project.lastAccessedAt?.toISOString() ?? null,
        };
        res.status(200).json(responseData);
    } catch (error: any) {
        console.error(`[API Error] Failed to get project ${projectId}:`, error);
        next(error);
    }
}

export async function deleteProjectHandler(req: Request, res: Response, next: NextFunction) {
    const { projectId } = req.params;
    if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ message: 'Invalid project ID' });
    console.log(`[API Projects] Request to delete project ${projectId}`);

    try {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { containerId: true }
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        if (project.containerId) {
            const containerId = project.containerId;
            console.log(`[API Projects] Attempting to stop/remove associated container ${containerId} for project ${projectId}`);
            try {
                const container = await getContainerSafely(containerId); // Use helper
                if (container) {
                    await container.remove({ force: true });
                    console.log(`[API Projects] Removed container ${containerId} from Docker.`);
                } else {
                    console.log(`[API Projects] Associated container ${containerId} not found in Docker, skipping Docker removal.`);
                }
            } catch (dockerError: any) {
                console.error(`[API Projects] Failed to remove container ${containerId} from Docker during project delete, continuing with DB delete:`, dockerError.message);
            }
        }

        await prisma.project.delete({
            where: { id: projectId }
        });

        console.log(`[API Projects] Deleted project ${projectId} and associated data from DB.`);
        res.status(204).send();
    } catch (error: any) {
        console.error(`[API Error] Failed to delete project ${projectId}:`, error);
        next(error);
    }
}
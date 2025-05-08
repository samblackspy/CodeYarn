// codeyarn/apps/server/src/routes/projectRoutes.ts
import express, { Router, Request, Response, NextFunction } from 'express';
import prisma from '@codeyarn/db'; // Import Prisma Client
import { FileSystemNode, Project as SharedProjectType } from '@codeyarn/shared-types'; // Use alias for Project type if needed
import { buildTreeFromFlatList, PrismaFileNode } from '../lib/utils'; // Import helper and type
import Docker from 'dockerode'; // Import Dockerode to interact with Docker

// Assume docker instance is passed or imported
const docker = new Docker();

// Helper Function to get Container Safely (copied from containerRoutes for standalone use if needed, or import from shared location)
async function getContainerSafely(containerId: string): Promise<Docker.Container | null> {
    try {
        const container = docker.getContainer(containerId);
        await container.inspect();
        return container;
    } catch (error: any) {
        if (error.statusCode === 404) { return null; } // Expected if container doesn't exist
        console.error(`[Docker Helper] Error inspecting container ${containerId}:`, error);
        throw error; // Rethrow unexpected errors
    }
}


const router: Router = express.Router();

/**
 * GET /api/projects/:projectId/files
 * Fetches the complete file tree structure for a given project from the database.
 */
router.get('/:projectId/files', async (req: Request, res: Response, next: NextFunction) => {
    const { projectId } = req.params;
    if (typeof projectId !== 'string' || !projectId) {
        return res.status(400).json({ message: 'Invalid project ID provided' });
    }
    console.log(`[API Projects] Request received for file tree of project: ${projectId}`);

    try {
        // Verify project exists first
        const projectExists = await prisma.project.findUnique({
            where: { id: projectId },
            select: { id: true } // Select minimal field just to check existence
        });
        if (!projectExists) {
            return res.status(404).json({ message: 'Project not found' });
        }

        // Fetch all file/folder nodes for this project with Date objects
        const fileNodesFromDb = await prisma.file.findMany({
            where: { projectId: projectId },
            select: { // Select fields needed for tree building
                id: true, name: true, path: true, projectId: true, parentId: true,
                isDirectory: true, createdAt: true, updatedAt: true,
            },
            orderBy: { path: 'asc' } // Optional ordering
        });

        // Use the helper function to build the tree and convert dates
        const fileTree = buildTreeFromFlatList(fileNodesFromDb as PrismaFileNode[], projectId); // Pass projectId

        console.log(`[API Projects] Sending file tree for project: ${projectId}`);
        res.status(200).json({
             // Keep structure consistent with potential future WebSocket message
             containerId: null, // Not relevant for this specific API response
             projectId: projectId,
             fileStructure: fileTree // Send the nested tree structure
        });

    } catch (error: any) {
        console.error(`[API Error] Failed to get file tree for project ${projectId}:`, error);
        next(error);
    }
});

// --- Project CRUD Operations ---

/**
 * POST /api/projects
 * Creates a new project record in the database.
 * Expects name, templateId, ownerId (ownerId would come from auth later).
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const { name, templateId, description } = req.body;
     const ownerId = 'clerk-user-placeholder'; // Placeholder owner ID

    // --- Input Validation ---
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ message: 'Missing or invalid project name' });
    }
    if (!templateId || typeof templateId !== 'string') {
        return res.status(400).json({ message: 'Missing or invalid templateId' });
    }
    // Optional: Validate description length if provided
    if (description && typeof description !== 'string') {
         return res.status(400).json({ message: 'Invalid description format' });
    }

    console.log(`[API Projects] Request to create project "${name}" with template ${templateId}`);

    try {
        // const templateExists = await prisma.template.findUnique({ where: { id: templateId } });
        // if (!templateExists) {
        //     return res.status(400).json({ message: `Template with ID ${templateId} not found` });
        // }

        // Create the project in the database
        const newProject = await prisma.project.create({
            data: {
                name: name.trim(),
                templateId: templateId,
                ownerId: ownerId,
                description: description?.trim() || null, // Trim description or set to null
                // containerId starts as null
            }
        });
        console.log(`[API Projects] Created project ${newProject.id}`);

        // Convert dates to ISO strings for the JSON response
        const responseData = {
            ...newProject,
            createdAt: newProject.createdAt.toISOString(),
            updatedAt: newProject.updatedAt.toISOString(),
            lastAccessedAt: newProject.lastAccessedAt?.toISOString() ?? null,
        };

        res.status(201).json(responseData);

    } catch (error: any) {
        console.error(`[API Error] Failed to create project "${name}":`, error);
        // Handle potential database errors (e.g., foreign key constraint if template doesn't exist)
        if (error.code === 'P2003') { // Foreign key constraint failed
             return res.status(400).json({ message: `Invalid templateId: ${templateId}` });
        }
        next(error);
    }
});

/**
 * GET /api/projects
 * Lists projects (e.g., for the current user - requires auth).
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const ownerId = 'clerk-user-placeholder'; // Placeholder owner ID
    console.log(`[API Projects] Request to list projects for owner ${ownerId}`);

    try {
        const projects = await prisma.project.findMany({
            where: { ownerId: ownerId }, // Filter by owner
            orderBy: { updatedAt: 'desc' }, // Order by most recently updated
            // Optionally include related data
            // include: { template: { select: { name: true } } }
        });

        // Convert dates for response consistency
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
});

/**
 * GET /api/projects/:projectId
 * Gets details for a specific project.
 */
router.get('/:projectId', async (req: Request, res: Response, next: NextFunction) => {
    const { projectId } = req.params;
    if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ message: 'Invalid project ID' });
    console.log(`[API Projects] Request to get details for project ${projectId}`);

    try {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            // include: { template: true } // Optionally include related template data
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        // Convert dates for response consistency
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
});

/**
 * DELETE /api/projects/:projectId
 * Deletes a specific project and associated data (files, container record).
 */
router.delete('/:projectId', async (req: Request, res: Response, next: NextFunction) => {
     const { projectId } = req.params;
    if (typeof projectId !== 'string' || !projectId) return res.status(400).json({ message: 'Invalid project ID' });
    console.log(`[API Projects] Request to delete project ${projectId}`);

    try {
        // 1. Find project to get containerId (if any)
        // Select containerId to attempt Docker cleanup
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { containerId: true }
        });

        // If project doesn't exist in DB, return 404
        if (!project) {
             return res.status(404).json({ message: 'Project not found' });
        }

        // 2. If associated container exists, attempt to stop and remove it via Docker API
        if (project.containerId) {
            const containerId = project.containerId;
            console.log(`[API Projects] Attempting to stop/remove associated container ${containerId} for project ${projectId}`);
            try {
                 const container = await getContainerSafely(containerId);
                 if (container) {
                    await container.remove({ force: true }); // Force stop & remove
                    console.log(`[API Projects] Removed container ${containerId} from Docker.`);
                 } else {
                    console.log(`[API Projects] Associated container ${containerId} not found in Docker, skipping Docker removal.`);
                 }
            } catch (dockerError) {
                // Log the error but continue with DB deletion
                console.error(`[API Projects] Failed to remove container ${containerId} from Docker during project delete, continuing with DB delete:`, dockerError);
            }
        }

        // 3. Delete the project record from the database
        // Prisma's cascading delete (defined in schema with onDelete: Cascade)
        // should handle deleting related Container and File records automatically.
        await prisma.project.delete({
            where: { id: projectId }
        });

        console.log(`[API Projects] Deleted project ${projectId} and associated data from DB.`);
        res.status(204).send(); // No content on successful delete

    } catch (error: any) {
        console.error(`[API Error] Failed to delete project ${projectId}:`, error);
         // Handle specific errors like P2025 (Record to delete does not exist - already handled by initial check)
         // if (error.code === 'P2025') { return res.status(404).json({ message: 'Project not found' }); }
        next(error);
    }
});


export default router;

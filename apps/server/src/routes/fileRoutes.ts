// codeyarn/apps/server/src/routes/fileRoutes.ts
import express, { Router, Request, Response, NextFunction } from 'express';
import prisma from '@codeyarn/db'; // Import Prisma Client
import Docker from 'dockerode';
import { PassThrough } from 'stream';
import type { Duplex } from 'stream';
import path from 'path';
const docker = new Docker();
const router: Router = express.Router();


// --- Helper Function to get Container ---
async function getContainerSafely(containerId: string): Promise<Docker.Container | null> {
    // ... (same as before)
    try {
        const container = docker.getContainer(containerId);
        await container.inspect();
        return container;
    } catch (error: any) {
        if (error.statusCode === 404) {
            console.warn(`[Docker Helper] Container not found: ${containerId}`);
            return null;
        }
        console.error(`[Docker Helper] Error inspecting container ${containerId}:`, error);
        throw error;
    }
}

// --- Helper Function to execute command in container ---
// Returns true on success (exit code 0), false otherwise
async function execCmdInContainer(container: Docker.Container, cmd: string[], workingDir: string = '/workspace'): Promise<{ success: boolean, stdout: string, stderr: string }> {
    console.log(`[Exec Helper] Running in ${container.id}: ${cmd.join(' ')}`);
    let execOutput = '';
    let execError = '';
    try {
        const exec = await container.exec({
            Cmd: cmd,
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: workingDir
        });
        const stream: Duplex = await exec.start({}); // Correctly await and type the stream

        const outputStream = new PassThrough();
        const errorStream = new PassThrough();
        outputStream.on('data', chunk => execOutput += chunk.toString());
        errorStream.on('data', chunk => execError += chunk.toString());
        container.modem.demuxStream(stream, outputStream, errorStream);

        await new Promise<void>((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('error', reject); // Reject on stream error
        });

        const inspectData = await exec.inspect();
        if (inspectData.ExitCode !== 0) {
            console.error(`[Exec Helper] Command failed with exit code ${inspectData.ExitCode}. Stderr: ${execError.trim()}`);
            return { success: false, stdout: execOutput, stderr: execError };
        }
        console.log(`[Exec Helper] Command succeeded.`);
        return { success: true, stdout: execOutput, stderr: execError };
    } catch (error) {
        console.error(`[Exec Helper] Error executing command:`, error);
        return { success: false, stdout: execOutput, stderr: execError || (error as Error).message };
    }
}


/**
 * GET /api/files/:fileId/details
 * Fetches the details of a specific file/folder node from the database.
 */
router.get('/:fileId/details', async (req: Request, res: Response, next: NextFunction) => {
    const { fileId } = req.params;
    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ message: 'Invalid file ID provided' });
    }
    console.log(`[API Files] Request received for details of node: ${fileId}`);

    try {
        const fileRecord = await prisma.file.findUnique({
            where: { id: fileId },
            // Exclude content field for this details endpoint
            select: {
                id: true,
                name: true,
                path: true,
                projectId: true,
                parentId: true,
                isDirectory: true,
                createdAt: true,
                updatedAt: true,
                // Do NOT select 'content' here
            }
        });

        if (!fileRecord) {
            return res.status(404).json({ message: 'File/Folder node not found' });
        }

        console.log(`[API Files] Sending details for node: ${fileRecord.path}`);
        // Convert Date objects to ISO strings for JSON compatibility
        const responseData = {
            ...fileRecord,
            createdAt: fileRecord.createdAt.toISOString(),
            updatedAt: fileRecord.updatedAt.toISOString(),
        };
        res.status(200).json(responseData);

    } catch (error: any) {
        console.error(`[API Error] Failed to get details for node ${fileId}:`, error);
        next(error);
    }
});


/**
 * GET /api/files/:fileId/content
 * Fetches the content of a specific file from the database.
 */
router.get('/:fileId/content', async (req: Request, res: Response, next: NextFunction) => {
    const { fileId } = req.params;
    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ message: 'Invalid file ID provided' });
    }
    console.log(`[API Files] Request received for content of file: ${fileId}`);

    try {
        const fileRecord = await prisma.file.findUnique({
            where: { id: fileId },
            select: { content: true, isDirectory: true, path: true }
        });

        if (!fileRecord) {
            return res.status(404).json({ message: 'File not found in database' });
        }
        if (fileRecord.isDirectory) {
            return res.status(400).json({ message: 'Cannot get content of a directory' });
        }

        console.log(`[API Files] Sending content for file: ${fileRecord.path}`);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(fileRecord.content || '');

    } catch (error: any) {
        console.error(`[API Error] Failed to get content for file ${fileId}:`, error);
        next(error);
    }
});

/**
 * PUT /api/files/:fileId/content
 * Updates the content of a specific file in the database
 * and syncs the change to the running container.
 */
router.put('/:fileId/content', async (req: Request, res: Response, next: NextFunction) => {
    const { fileId } = req.params;
    const newContent = req.body;

    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ message: 'Invalid file ID provided' });
    }
    if (typeof newContent !== 'string') {
         return res.status(400).json({ message: 'Invalid or missing file content in request body (expecting raw text)' });
    }

    console.log(`[API Files] Request received to update content for file: ${fileId}`);

    try {
        // --- 1. Find the file record in the database ---
        const fileRecord = await prisma.file.findUnique({
            where: { id: fileId },
            select: { path: true, isDirectory: true, projectId: true }
        });

        if (!fileRecord) {
            return res.status(404).json({ message: 'File not found in database' });
        }
        if (fileRecord.isDirectory) {
            return res.status(400).json({ message: 'Cannot set content of a directory' });
        }

        // --- 2. Update the content in the database ---
        // Use a transaction to update content and get the updated timestamp atomically
        const updatedFile = await prisma.file.update({
            where: { id: fileId },
            data: { content: newContent },
            select: { id: true, path: true, updatedAt: true, projectId: true } // Select needed fields including projectId
        });
        console.log(`[API Files] Updated content in DB for file: ${fileRecord.path}`);

        // --- 3. Sync the content to the running container (if any) ---
        const project = await prisma.project.findUnique({
            where: { id: updatedFile.projectId }, // Use projectId from updatedFile
            select: { containerId: true }
        });

        if (project?.containerId) {
            const containerId = project.containerId;
            console.log(`[API Files] Syncing content to container ${containerId} for file ${fileRecord.path}`);
            try {
                const container = docker.getContainer(containerId);
                const inspectData = await container.inspect();

                if (!inspectData.State.Running) {
                     console.warn(`[API Files] Container ${containerId} is not running. Skipping file sync for ${fileRecord.path}.`);
                } else {
                    // Ensure the path is within /workspace
                    let filePathInContainer = fileRecord.path;
                    // If the path starts with /, but is not /workspace, prepend /workspace
                    if (filePathInContainer.startsWith('/') && !filePathInContainer.startsWith('/workspace')) {
                        // Remove leading slash to avoid double slash
                        const pathWithoutLeadingSlash = filePathInContainer.substring(1);
                        filePathInContainer = `/workspace/${pathWithoutLeadingSlash}`;
                    }
                    const escapedContent = newContent.replace(/'/g, "'\\''");
                    // Ensure directory exists before writing
                    const cmd = `mkdir -p "$(dirname "${filePathInContainer}")" && echo '${escapedContent}' > "${filePathInContainer}"`;

                    console.log(`[API Files] Executing sync command in ${containerId}: sh -c "echo ... > ${filePathInContainer}"`);

                    const exec = await container.exec({
                        Cmd: ['sh', '-c', cmd],
                        AttachStdout: true, AttachStderr: true, WorkingDir: '/workspace'
                    });

                    const startOptions: Docker.ExecStartOptions = {};
                    const stream: Duplex = await exec.start(startOptions);

                    let execError = '';
                    const errorStream = new PassThrough();
                    errorStream.on('data', chunk => execError += chunk.toString());
                    // Only demux stderr, ignore stdout for this command
                    container.modem.demuxStream(stream, process.stdout, errorStream); // Pipe stdout to server logs for debug if needed

                    await new Promise<void>((resolve, reject) => {
                        stream.on('end', () => {
                            if (execError) {
                                console.error(`[API Files] Error output during file sync for ${filePathInContainer} to container ${containerId}: ${execError}`);
                            } else {
                                console.log(`[API Files] Successfully synced file ${filePathInContainer} to container ${containerId}`);
                            }
                            resolve();
                        });
                        stream.on('error', (err: Error) => {
                            console.error(`[API Files] Stream error during file sync for ${filePathInContainer}:`, err);
                            reject(err);
                        });
                    });

                    // Optional: Check exit code
                    const execInspect = await exec.inspect();
                    if (execInspect.ExitCode !== 0) {
                        console.error(`[API Files] Sync command exited with code ${execInspect.ExitCode} for file ${filePathInContainer}. Stderr: ${execError}`);
                    }
                }

            } catch (dockerError: any) {
                console.error(`[API Error] Failed to sync file ${fileRecord.path} to container ${containerId}:`, dockerError);
            }
        } else {
             console.log(`[API Files] No active container found for project ${updatedFile.projectId}. Skipping file sync for ${fileRecord.path}.`);
        }

        // --- 4. Respond to Client ---
        res.status(200).json({
            message: 'File content updated successfully',
            fileId: updatedFile.id,
            path: updatedFile.path,
            // Send back the actual updated timestamp from the database
            updatedAt: updatedFile.updatedAt.toISOString(),
        });

    } catch (error: any) {
        console.error(`[API Error] Failed to update content for file ${fileId}:`, error);
        next(error);
    }
});



 
/**
 * POST /api/files
 * Creates a new file or directory in the database and attempts to create it in the container.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const { projectId, parentId, name, isDirectory } = req.body;

    // --- Validation ---
    if (!projectId || typeof projectId !== 'string') return res.status(400).json({ message: 'Missing or invalid projectId' });
    if (parentId && typeof parentId !== 'string') return res.status(400).json({ message: 'Invalid parentId' });
    if (!name || typeof name !== 'string' || name.includes('/') || name.trim() === '') return res.status(400).json({ message: 'Invalid name' });
    if (typeof isDirectory !== 'boolean') return res.status(400).json({ message: 'Missing or invalid isDirectory flag' });

    console.log(`[API Files] Request to create ${isDirectory ? 'directory' : 'file'} "${name}" in project ${projectId} under parent ${parentId || 'root'}`);

    try {
        // --- Determine Parent Path ---
        let parentPath = '/workspace'; // Default root path within container/project
        if (parentId) {
            const parentNode = await prisma.file.findUnique({ where: { id: parentId, projectId: projectId } });
            if (!parentNode) return res.status(404).json({ message: 'Parent directory not found' });
            if (!parentNode.isDirectory) return res.status(400).json({ message: 'Parent is not a directory' });
            parentPath = parentNode.path;
        }
        const newPath = path.join(parentPath, name).replace(/\\/g, '/'); // Construct full path, normalize slashes

        // --- Check for Existing Path ---
        const existing = await prisma.file.findUnique({ where: { projectId_path: { projectId, path: newPath } } });
        if (existing) {
            return res.status(409).json({ message: `An item named "${name}" already exists at this location.` });
        }

        // --- Create DB Record ---
        const newNode = await prisma.file.create({
            data: {
                name: name.trim(),
                path: newPath,
                isDirectory: isDirectory,
                projectId: projectId,
                parentId: parentId || null,
                content: isDirectory ? null : '', // Start files with empty content
            }
        });
        console.log(`[API Files] Created DB record for ${newNode.path} (ID: ${newNode.id})`);

        // --- Attempt to Create in Container ---
        const project = await prisma.project.findUnique({ where: { id: projectId }, select: { containerId: true } });
        if (project?.containerId) {
            const container = await getContainerSafely(project.containerId);
            if (container) {
                 const inspectData = await container.inspect();
                 if (inspectData.State.Running) {
                    let cmd: string[];
                    if (isDirectory) {
                        cmd = ['mkdir', '-p', newPath]; // mkdir -p creates parent directories if needed
                    } else {
                        // Ensure directory exists, then touch the file
                        cmd = ['sh', '-c', `mkdir -p "$(dirname "${newPath}")" && touch "${newPath}"`];
                    }
                    const success = await execCmdInContainer(container, cmd);
                    if (!success) {
                        // Log warning but don't fail request as DB entry was created
                        console.warn(`[API Files] Failed to create ${newPath} in container ${project.containerId}, but DB record created.`);
                    } else {
                         console.log(`[API Files] Successfully created ${newPath} in container ${project.containerId}`);
                    }
                 } else { console.warn(`Container ${project.containerId} not running, skipping container creation.`); }
            }
        }

        // --- Respond ---
        const responseData = {
            ...newNode,
            createdAt: newNode.createdAt.toISOString(),
            updatedAt: newNode.updatedAt.toISOString(),
        };
        res.status(201).json(responseData);

    } catch (error: any) {
        console.error(`[API Error] Failed to create file/folder "${name}":`, error);
        // Handle potential unique constraint violation if check failed due to race condition
        if (error.code === 'P2002' && error.meta?.target?.includes('projectId_path_unique')) {
             return res.status(409).json({ message: `An item named "${name}" already exists at this location.` });
        }
        next(error);
    }
});


/**
 * DELETE /api/files/:fileId
 * Deletes a file or directory (recursively) from DB and attempts deletion in container.
 */
router.delete('/:fileId', async (req: Request, res: Response, next: NextFunction) => {
    const { fileId } = req.params;
    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ message: 'Invalid file ID provided' });
    }
    console.log(`[API Files] Request to delete node: ${fileId}`);

    try {
        // --- Find Node and its Descendants (if directory) ---
        // Use transaction to ensure we find and delete consistently
        const deletedNode = await prisma.$transaction(async (tx) => {
            const nodeToDelete = await tx.file.findUnique({
                where: { id: fileId },
                select: { id: true, path: true, projectId: true, isDirectory: true }
            });
            if (!nodeToDelete) {
                // Throw error to rollback transaction and return 404 later
                throw new Error('NotFound');
            }

            const idsToDelete: string[] = [nodeToDelete.id];
            if (nodeToDelete.isDirectory) {
                // Iteratively find descendants within the transaction
                const queue = [nodeToDelete.id];
                while (queue.length > 0) {
                    const parentId = queue.shift()!; // Non-null assertion ok as we control the queue
                    const children = await tx.file.findMany({
                        where: { parentId: parentId },
                        select: { id: true, isDirectory: true }
                    });
                    children.forEach(child => {
                        idsToDelete.push(child.id);
                        if (child.isDirectory) {
                            queue.push(child.id);
                        }
                    });
                }
                console.log(`[API Files] Found ${idsToDelete.length - 1} descendants for directory ${nodeToDelete.path}`);
            }

            // --- Delete from Database ---
            const deleteResult = await tx.file.deleteMany({
                where: { id: { in: idsToDelete } }
            });
            console.log(`[API Files] Deleted ${deleteResult.count} record(s) from DB for path ${nodeToDelete.path}`);

            return nodeToDelete; // Return the deleted node info for container deletion
        });

        // --- Attempt to Delete in Container ---
         const project = await prisma.project.findUnique({ where: { id: deletedNode.projectId }, select: { containerId: true } });
         if (project?.containerId) {
             const container = await getContainerSafely(project.containerId);
             if (container) {
                  const inspectData = await container.inspect();
                  if (inspectData.State.Running) {
                     const cmd = ['rm', '-rf', deletedNode.path]; // Force recursive delete
                     const { success } = await execCmdInContainer(container, cmd);
                     if (!success) {
                         console.warn(`[API Files] Failed to delete ${deletedNode.path} in container ${project.containerId}, but DB record(s) deleted.`);
                     } else {
                          console.log(`[API Files] Successfully deleted ${deletedNode.path} in container ${project.containerId}`);
                     }
                  } else { console.warn(`Container ${project.containerId} not running, skipping container deletion.`); }
             }
         }

        // --- Respond ---
        // Use count from DB operation (deleteResult is not available outside transaction)
        // For simplicity, just send success
        res.status(200).json({ message: 'Item deleted successfully' });

    } catch (error: any) {
        // Handle specific error from transaction
        if (error.message === 'NotFound') {
             return res.status(404).json({ message: 'File/Folder not found' });
        }
        console.error(`[API Error] Failed to delete node ${fileId}:`, error);
        next(error);
    }
});


/**
 * PUT /api/files/:fileId/rename
 * Renames a file or directory in the DB and attempts rename in container.
 * Handles path updates for descendants if renaming a directory.
 */
router.put('/:fileId/rename', async (req: Request, res: Response, next: NextFunction) => {
    const { fileId } = req.params;
    const { newName } = req.body;

    // --- Validation ---
    if (typeof fileId !== 'string' || !fileId) return res.status(400).json({ message: 'Invalid file ID' });
    if (!newName || typeof newName !== 'string' || newName.includes('/') || newName.includes('\\') || newName.trim() === '') return res.status(400).json({ message: 'Invalid new name' });

    const trimmedNewName = newName.trim();
    console.log(`[API Files] Request to rename node ${fileId} to "${trimmedNewName}"`);

    try {
        // --- Use Transaction for DB operations ---
        // Transaction will return an object with updated node and original details
        const { updatedNodeResult, originalPath, originalProjectId } = await prisma.$transaction(async (tx) => {
            // 1. Find the node to rename
            const nodeToRename = await tx.file.findUnique({
                where: { id: fileId },
                select: { id: true, name: true, path: true, projectId: true, parentId: true, isDirectory: true }
            });
            if (!nodeToRename) throw new Error('NotFound');
            if (nodeToRename.name === trimmedNewName) throw new Error('SameName');

            const currentOriginalPath = nodeToRename.path; // Store locally for use within transaction
            const currentOriginalProjectId = nodeToRename.projectId;

            const parentPath = path.dirname(currentOriginalPath).replace(/\\/g, '/');
            const newPath = path.join(parentPath, trimmedNewName).replace(/\\/g, '/');

            // 2. Check if a node with the new name/path already exists
            const existing = await tx.file.findUnique({
                where: { projectId_path: { projectId: currentOriginalProjectId, path: newPath } }
            });
            if (existing) throw new Error('Conflict');

            // 3. If it's a directory, find all descendants
            const descendantsToUpdate: { id: string, path: string }[] = [];
            if (nodeToRename.isDirectory) {
                const queue: { id: string, name: string, path: string, projectId: string, parentId: string | null, isDirectory: boolean }[] = [nodeToRename];
                while (queue.length > 0) {
                    const current = queue.shift()!;
                    const children = await tx.file.findMany({
                        where: { parentId: current.id },
                        select: { id: true, name: true, path: true, projectId: true, parentId: true, isDirectory: true } // Select fields matching queue type
                    });
                    children.forEach(child => {
                        descendantsToUpdate.push({ id: child.id, path: child.path });
                        if (child.isDirectory) queue.push(child);
                    });
                }
                console.log(`[API Files] Found ${descendantsToUpdate.length} descendants to update path for rename.`);
            }

            // 4. Update paths for all descendants (if any)
            const oldPathPrefix = currentOriginalPath + '/';
            const newPathPrefix = newPath + '/';
            for (const descendant of descendantsToUpdate) {
                if (descendant.path.startsWith(oldPathPrefix)) {
                    const updatedDescendantPath = descendant.path.replace(oldPathPrefix, newPathPrefix);
                    await tx.file.update({ where: { id: descendant.id }, data: { path: updatedDescendantPath } });
                } else {
                     console.warn(`[API Files] Descendant path ${descendant.path} did not match prefix ${oldPathPrefix} during rename.`);
                }
            }

            // 5. Update the target node itself (name and path)
            const updatedNodeData = await tx.file.update({
                where: { id: fileId },
                data: { name: trimmedNewName, path: newPath },
                select: { id: true, name: true, path: true, projectId: true, parentId: true, isDirectory: true, createdAt: true, updatedAt: true }
            });

            // Return results needed outside the transaction
            return {
                updatedNodeResult: updatedNodeData,
                originalPath: currentOriginalPath,
                originalProjectId: currentOriginalProjectId
            };
        }); // End Transaction

        console.log(`[API Files] Renamed node ${fileId} to "${trimmedNewName}" in DB.`);

        // --- Attempt to Rename in Container ---
        // Use projectId returned from transaction
        const project = await prisma.project.findUnique({ where: { id: originalProjectId }, select: { containerId: true } });
        if (project?.containerId) {
            const container = await getContainerSafely(project.containerId);
            if (container) {
                const inspectData = await container.inspect();
                if (inspectData.State.Running) {
                    // Use originalPath returned from transaction
                    const oldPathForContainer = originalPath;
                    const newPathForContainer = updatedNodeResult.path; // Use path from the final updated node
                    const cmd = ['mv', '-T', oldPathForContainer, newPathForContainer];
                    const { success, stderr } = await execCmdInContainer(container, cmd);
                    if (!success) {
                        console.warn(`[API Files] Failed to rename ${oldPathForContainer} to ${newPathForContainer} in container ${project.containerId}. Error: ${stderr}. DB record(s) updated.`);
                     } else {
                        console.log(`[API Files] Successfully renamed ${oldPathForContainer} to ${newPathForContainer} in container ${project.containerId}`);
                    }
                } else { console.warn(`Container ${project.containerId} not running, skipping container rename.`); }
            }
        }

        // --- Respond ---
        // Use the updated node data returned from the transaction
        const responseData = {
            ...updatedNodeResult,
            createdAt: updatedNodeResult.createdAt.toISOString(),
            updatedAt: updatedNodeResult.updatedAt.toISOString(),
        };
        res.status(200).json(responseData);

    } catch (error: any) {
        console.error(`[API Error] Failed to rename node ${fileId} to "${trimmedNewName}":`, error);
        if (error.message === 'NotFound') return res.status(404).json({ message: 'File/Folder not found' });
        if (error.message === 'SameName') return res.status(400).json({ message: 'New name is the same as the old name' });
        if (error.message === 'Conflict' || (error.code === 'P2002' && error.meta?.target?.includes('projectId_path'))) {
            return res.status(409).json({ message: `An item named "${trimmedNewName}" already exists at this location.` });
        }
        next(error);
    }
});

export default router;

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
            WorkingDir: workingDir,
            Tty: false
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
/**
 * GET /api/files/:fileId/content
 * Fetches the content of a specific file.
 * If content is null in DB (stale), fetches from container, updates DB, then returns.
 */

router.get('/:fileId/content', async (req: Request, res: Response, next: NextFunction) => {
    const { fileId } = req.params;

    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ error: 'Invalid file ID provided.' });
    }
    console.log(`[API Files GET /content] Request for fileId: ${fileId}`);

    try {
        let fileRecord = await prisma.file.findUnique({
            where: { id: fileId },
            select: { content: true, isDirectory: true, path: true, projectId: true }
        });

        if (!fileRecord) {
            return res.status(404).json({ error: 'File not found in database.' });
        }

        if (fileRecord.isDirectory) {
            return res.status(400).json({ error: 'Cannot get content of a directory.' });
        }

        let fileContent: string | null = fileRecord.content;

        // If content is null in DB, try to fetch from container
        if (fileContent === null) {
            console.log(`[API Files GET /content] DB content for path "${fileRecord.path}" (ID: ${fileId}) is null. Attempting to fetch from container.`);
            const project = await prisma.project.findUnique({
                where: { id: fileRecord.projectId },
                select: { containerId: true }
            });

            if (project?.containerId) {
                const container = docker.getContainer(project.containerId);
                try {
                    await container.inspect(); // Check if container exists and is accessible

                    let pathInContainer = fileRecord.path; // e.g., /index.js or /app/somefile.js
                    // Construct absolute path within /workspace
                    if (!pathInContainer.startsWith('/workspace/')) {
                         pathInContainer = path.posix.join('/workspace', pathInContainer.replace(/^\//, ''));
                    }
                    pathInContainer = path.posix.normalize(pathInContainer);


                    console.log(`[API Files GET /content] Fetching content from container ${project.containerId} for path ${pathInContainer}`);
                    
                    const execResult = await execCmdInContainer(container, ['cat', pathInContainer], '/'); // WorkingDir as / for absolute path

                    if (execResult.success) {
                        fileContent = execResult.stdout;
                        console.log(`[API Files GET /content] Successfully fetched content for "${pathInContainer}" from container. Length: ${fileContent.length}`);
                        
                        // Update the database with the fresh content and new timestamp
                        await prisma.file.update({
                            where: { id: fileId },
                            data: { content: fileContent, updatedAt: new Date() }
                        });
                    } else {
                        console.error(`[API Files GET /content] Failed to 'cat' file "${pathInContainer}" from container. Stderr: ${execResult.stderr}`);
                        // Keep fileContent as null or set to empty string to indicate fetch failure but prevent future fetches until next modification
                        // Depending on desired behavior, you might want to set it to an empty string or keep it null.
                        // Setting to empty string might be preferable if cat fails because file is empty (exit code 0) vs file not found (exit code non-zero).
                        // The helper already returns stdout as empty if cat fails but exit code is 0.
                        fileContent = ''; // Default to empty if cat fails to get content
                    }
                } catch (dockerError: any) {
                    console.error(`[API Files GET /content] Docker error fetching content for "${fileRecord.path}" (container: ${project.containerId}):`, dockerError.message);
                    fileContent = ''; // Default to empty on error
                }
            } else {
                console.warn(`[API Files GET /content] No active container for project ${fileRecord.projectId} to fetch content for "${fileRecord.path}".`);
                fileContent = ''; // Default to empty if no container
            }
        } else {
            console.log(`[API Files GET /content] Serving cached content from DB for path "${fileRecord.path}" (ID: ${fileId})`);
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(fileContent || ''); // Ensure we always send a string

    } catch (error: any) {
        console.error(`[API Error GET /content] Failed for fileId ${fileId}:`, error);
        // Pass to Express error handler
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
    const newContent = req.body; // This comes from app.use(express.text(...))

    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ error: 'Invalid file ID provided.' });
    }
    if (typeof newContent !== 'string') {
        return res.status(400).json({ error: 'Invalid or missing file content in request body (expecting raw text).' });
    }

    console.log(`[API Files PUT /content] Request to update fileId: ${fileId}. Content length: ${newContent.length}`);

    try {
        const fileRecord = await prisma.file.findUnique({
            where: { id: fileId },
            select: { path: true, isDirectory: true, projectId: true }
        });

        if (!fileRecord) {
            return res.status(404).json({ error: 'File not found in database.' });
        }
        if (fileRecord.isDirectory) {
            return res.status(400).json({ error: 'Cannot set content of a directory.' });
        }

        // --- 1. Update the content in the database ---
        const updatedFileInDb = await prisma.file.update({
            where: { id: fileId },
            data: { content: newContent, updatedAt: new Date() },
            select: { id: true, path: true, updatedAt: true, projectId: true }
        });
        console.log(`[API Files PUT /content] Updated content in DB for path: ${updatedFileInDb.path}`);

        // --- 2. Sync the content to the running container (if any) ---
        const project = await prisma.project.findUnique({
            where: { id: updatedFileInDb.projectId },
            select: { containerId: true }
        });

        if (project?.containerId) {
            const container = docker.getContainer(project.containerId);
            try {
                await container.inspect(); // Check if container exists and is accessible

                let filePathInContainer = updatedFileInDb.path; // Path from DB, e.g., /index.js
                // Construct absolute path within /workspace
                if (!filePathInContainer.startsWith('/workspace/')) {
                     filePathInContainer = path.posix.join('/workspace', filePathInContainer.replace(/^\//, ''));
                }
                filePathInContainer = path.posix.normalize(filePathInContainer);

                // Escape content for shell 'echo'. This is basic.
                // For complex content, writing via a temporary file and `mv` or using `putArchive` is more robust.
                const escapedContent = newContent.replace(/'/g, "'\\''"); // Escapes single quotes for 'sh -c echo'
                
                // Command to ensure directory exists and then write file content
                // Using printf is generally safer than echo for arbitrary content
                const dirnameForCmd = path.posix.dirname(filePathInContainer);
                const cmd = `mkdir -p '${dirnameForCmd}' && printf '%s' '${escapedContent}' > '${filePathInContainer}'`;
                
                console.log(`[API Files PUT /content] Executing sync command in container ${project.containerId} for path ${filePathInContainer}`);
                
                const execResult = await execCmdInContainer(container, ['sh', '-c', cmd], '/'); // WorkingDir as / for absolute paths

                if (execResult.success) {
                    console.log(`[API Files PUT /content] Successfully synced file ${filePathInContainer} to container.`);
                } else {
                    console.error(`[API Files PUT /content] Failed to sync file ${filePathInContainer} to container. Stderr: ${execResult.stderr}`);
                    // Note: DB was already updated. Client will get a success response.
                    // Consider how to signal this sync failure to the client if critical.
                }
            } catch (dockerError: any) {
                console.error(`[API Files PUT /content] Docker error syncing to container ${project.containerId} for path ${fileRecord.path}:`, dockerError.message);
                // DB is updated. Client still gets success from DB update.
            }
        } else {
            console.log(`[API Files PUT /content] No active container for project ${updatedFileInDb.projectId}. Skipping file sync for ${updatedFileInDb.path}.`);
        }

        // --- 3. Respond to Client ---
        res.status(200).json({
            message: 'File content updated successfully in database.', // Clarify that DB update was the primary success
            fileId: updatedFileInDb.id,
            path: updatedFileInDb.path,
            updatedAt: updatedFileInDb.updatedAt.toISOString(),
        });

    } catch (error: any) {
        console.error(`[API Error PUT /content] Failed for fileId ${fileId}:`, error);
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
                     // Make sure path is relative to workspace or is fully workspace-prefixed
                  const filePath = deletedNode.path.startsWith('/workspace/') 
                      ? deletedNode.path // Already has workspace prefix
                      : (deletedNode.path.startsWith('/') 
                          ? `/workspace${deletedNode.path}` // Add workspace prefix to absolute path
                          : `/workspace/${deletedNode.path}`); // Add workspace prefix to relative path
                  console.log(`[API Files] Normalized deletion path from ${deletedNode.path} to ${filePath}`);
                  const cmd = ['rm', '-rf', filePath]; // Force recursive delete
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

// src/routes/fileHandlers.ts
import { Request, Response, NextFunction } from 'express';
import prisma from '@codeyarn/db';
import path from 'path';
import { getContainerSafely, execCmdInContainer } from '../services/dockerService';
 
/**
 * GET /api/files/:fileId/details
 * Fetches the details of a specific file/folder node from the database.
 */
export async function getFileDetailsHandler(req: Request, res: Response, next: NextFunction) {
    const { fileId } = req.params;
    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ message: 'Invalid file ID provided' });
    }
    console.log(`[API Files] Request received for details of node: ${fileId}`);

    try {
        const fileRecord = await prisma.file.findUnique({
            where: { id: fileId },
            select: {
                id: true, name: true, path: true, projectId: true,
                parentId: true, isDirectory: true, createdAt: true, updatedAt: true,
            }
        });

        if (!fileRecord) {
            return res.status(404).json({ message: 'File/Folder node not found' });
        }

        console.log(`[API Files] Sending details for node: ${fileRecord.path}`);
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
}

/**
 * GET /api/files/:fileId/content
 * Fetches the content of a specific file.
 * If content is null in DB (stale), fetches from container, updates DB, then returns.
 */
export async function getFileContentHandler(req: Request, res: Response, next: NextFunction) {
    const { fileId } = req.params;
    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ error: 'Invalid file ID provided.' });
    }
    console.log(`[API Files GET /content] Request for fileId: ${fileId}`);

    try {
        const fileRecord = await prisma.file.findUnique({
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

        if (fileContent === null) {
            console.log(`[API Files GET /content] DB content for path "${fileRecord.path}"
                 (ID: ${fileId}) is null. Attempting to fetch from container.`);
            const project = await prisma.project.findUnique({
                where: { id: fileRecord.projectId },
                select: { containerId: true }
            });

            if (project?.containerId) {
                const container = await getContainerSafely(project.containerId); // Use helper
                if (container) {
                    try {
                        let pathInContainer = fileRecord.path;
                        if (!pathInContainer.startsWith('/workspace/')) {
                            pathInContainer = path.posix.join('/workspace', pathInContainer.replace(/^\//, ''));
                        }
                        pathInContainer = path.posix.normalize(pathInContainer);

                        console.log(`[API Files GET /content] Fetching content from container ${project.containerId} for path ${pathInContainer}`);
                        const execResult = await execCmdInContainer(container, ['cat', pathInContainer], '/');

                        if (execResult.success) {
                            fileContent = execResult.stdout;
                            console.log(`[API Files GET /content] Successfully fetched content for "${pathInContainer}" from container. Length: ${fileContent.length}`);
                            await prisma.file.update({
                                where: { id: fileId },
                                data: { content: fileContent, updatedAt: new Date() }
                            });
                        } else {
                            console.error(`[API Files GET /content] Failed to 'cat' file "${pathInContainer}" from container. Stderr: ${execResult.stderr}`);
                            fileContent = '';
                        }
                    } catch (dockerError: any) {
                        console.error(`[API Files GET /content] Docker error fetching content for "${fileRecord.path}" (container: ${project.containerId}):`, dockerError.message);
                        fileContent = '';
                    }
                } else {
                     console.warn(`[API Files GET /content] Container ${project.containerId} for project ${fileRecord.projectId} not found or not accessible to fetch content for "${fileRecord.path}".`);
                     fileContent = '';
                }
            } else {
                console.warn(`[API Files GET /content] No active container for project ${fileRecord.projectId} to fetch content for "${fileRecord.path}".`);
                // Keep fileContent as null or set to empty string to indicate fetch failure but prevent future fetches until next modification
                // Setting to empty string might be preferable if cat fails because file is empty (exit code 0) vs file not found (exit code non-zero).
                // The helper already returns stdout as empty if cat fails but exit code is 0.
                fileContent = ''; // Default to empty if cat fails to get content
            }
        } else {
            console.log(`[API Files GET /content] Serving cached content from DB for path "${fileRecord.path}" (ID: ${fileId})`);
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(fileContent || ''); //nsure we always send a string
    } catch (error: any) {
        console.error(`[API Error GET /content] Failed for fileId ${fileId}:`, error);
        next(error);
    }
}


/**
 * PUT /api/files/:fileId/content
 * Updates the content of a specific file in the database
 * and syncs the change to the running container.
 */
export async function updateFileContentHandler(req: Request, res: Response, next: NextFunction) {
    const { fileId } = req.params;
    const newContent = req.body; // from app.use(express.text(...))

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

        const updatedFileInDb = await prisma.file.update({
            where: { id: fileId },
            data: { content: newContent, updatedAt: new Date() },
            select: { id: true, path: true, updatedAt: true, projectId: true }
        });
        console.log(`[API Files PUT /content] Updated content in DB for path: ${updatedFileInDb.path}`);

        const project = await prisma.project.findUnique({
            where: { id: updatedFileInDb.projectId },
            select: { containerId: true }
        });

        if (project?.containerId) {
            const container = await getContainerSafely(project.containerId); // Use helper
            if (container) {
                try {
                    let filePathInContainer = updatedFileInDb.path; // Path from DB, e.g., /index.js
                    // Construct absolute path within /workspace
                    if (!filePathInContainer.startsWith('/workspace/')) {
                        filePathInContainer = path.posix.join('/workspace', filePathInContainer.replace(/^\//, ''));
                    }
                    filePathInContainer = path.posix.normalize(filePathInContainer);
                    // Escape single quotes in content for shell 'echo'
                    const escapedContent = newContent.replace(/'/g, "'\\''");
                    // Ensure directory exists before writing file
                    const dirnameForCmd = path.posix.dirname(filePathInContainer);
                    const cmdForContainer = `mkdir -p '${dirnameForCmd}' && printf '%s' '${escapedContent}' > '${filePathInContainer}'`;

                    console.log(`[API Files PUT /content] Executing sync command in container ${project.containerId} for path ${filePathInContainer}`);
                    const execResult = await execCmdInContainer(container, ['sh', '-c', cmdForContainer], '/');

                    if (execResult.success) {
                        console.log(`[API Files PUT /content] Successfully synced file ${filePathInContainer} to container.`);
                    } else {
                        console.error(`[API Files PUT /content] Failed to sync file ${filePathInContainer} to container. Stderr: ${execResult.stderr}`);
                    }
                } catch (dockerError: any) {
                    console.error(`[API Files PUT /content] Docker error syncing to container ${project.containerId} for path ${fileRecord.path}:`, dockerError.message);
                }
            }  else {
                console.warn(`[API Files PUT /content] Container ${project.containerId} not found or not accessible for project ${updatedFileInDb.projectId}. Skipping file sync for ${updatedFileInDb.path}.`);
            }
        } else {
            console.log(`[API Files PUT /content] No active container for project ${updatedFileInDb.projectId}. Skipping file sync for ${updatedFileInDb.path}.`);
        }

        res.status(200).json({
            message: 'File content updated successfully in database.',
            fileId: updatedFileInDb.id,
            path: updatedFileInDb.path,
            updatedAt: updatedFileInDb.updatedAt.toISOString(),
        });
    } catch (error: any) {
        console.error(`[API Error PUT /content] Failed for fileId ${fileId}:`, error);
        next(error);
    }
}


/**
 * POST /api/files
 * Creates a new file or directory in the database and attempts to create it in the container.
 */

export async function createFileOrDirectoryHandler(req: Request, res: Response, next: NextFunction) {
    const { projectId, parentId, name, isDirectory } = req.body;

    // --- Validation ---
    if (!projectId || typeof projectId !== 'string') return res.status(400).json({ message: 'Missing or invalid projectId' });
    if (parentId && typeof parentId !== 'string') return res.status(400).json({ message: 'Invalid parentId' });
    if (!name || typeof name !== 'string' || name.includes('/') || name.trim() === '') return res.status(400).json({ message: 'Invalid name' });
    if (typeof isDirectory !== 'boolean') return res.status(400).json({ message: 'Missing or invalid isDirectory flag' });

    console.log(`[API Files] Request to create ${isDirectory ? 'directory' : 'file'} "${name}" in project ${projectId} under parent ${parentId || 'root'}`);

    try {
        // --- Determine Parent Path ---
        let parentPath = '/workspace';
        if (parentId) {
            const parentNode = await prisma.file.findUnique({ where: { id: parentId, projectId: projectId } });
            if (!parentNode) return res.status(404).json({ message: 'Parent directory not found' });
            if (!parentNode.isDirectory) return res.status(400).json({ message: 'Parent is not a directory' });
            parentPath = parentNode.path;
        }
        const newPath = path.join(parentPath, name).replace(/\\/g, '/');

        // --- Check for Existing Path ---
        const existing = await prisma.file.findUnique({ where: { projectId_path: { projectId, path: newPath } } });
        if (existing) {
            return res.status(409).json({ message: `An item named "${name}" already exists at this location.` });
        }

        // --- Create DB Record ---
        const newNode = await prisma.file.create({
            data: {
                name: name.trim(), path: newPath, isDirectory: isDirectory,
                projectId: projectId, parentId: parentId || null,
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
                    let cmdInContainer: string[];
                    if (isDirectory) {
                        cmdInContainer = ['mkdir', '-p', newPath];
                    } else {
                        cmdInContainer = ['sh', '-c', `mkdir -p "$(dirname "${newPath}")" && touch "${newPath}"`];
                    }
                    const { success } = await execCmdInContainer(container, cmdInContainer, '/'); // Working dir / for absolute paths in cmd
                    if (!success) {
                        console.warn(`[API Files] Failed to create ${newPath} in container ${project.containerId}, but DB record created.`);
                    } else {
                        console.log(`[API Files] Successfully created ${newPath} in container ${project.containerId}`);
                    }
                } else { console.warn(`Container ${project.containerId} not running, skipping container creation.`); }
            } else { console.warn(`Container ${project.containerId} not found or not accessible. Skipping container creation of ${newPath}.`);}
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
        if (error.code === 'P2002' && error.meta?.target?.includes('projectId_path')) { 
        // Handle potential unique constraint violation if check failed due to race condition
        return res.status(409).json({ message: `An item named "${name}" already exists at this location.` });
        }
        next(error);
    }
}


/**
 * DELETE /api/files/:fileId
 * Deletes a file or directory (recursively) from DB and attempts deletion in container.
 */
export async function deleteFileOrDirectoryHandler(req: Request, res: Response, next: NextFunction) {
    const { fileId } = req.params;
    if (typeof fileId !== 'string' || !fileId) {
        return res.status(400).json({ message: 'Invalid file ID provided' });
    }
    console.log(`[API Files] Request to delete node: ${fileId}`);

    try {
        const deletedNode = await prisma.$transaction(async (tx) => {
            const nodeToDelete = await tx.file.findUnique({
                where: { id: fileId },
                select: { id: true, path: true, projectId: true, isDirectory: true }
            });
            if (!nodeToDelete) {
                throw new Error('NotFound');
            }

            const idsToDelete: string[] = [nodeToDelete.id];
            if (nodeToDelete.isDirectory) {
                const queue = [nodeToDelete.id];
                while (queue.length > 0) {
                    const currentParentId = queue.shift()!;
                    const children = await tx.file.findMany({
                        where: { parentId: currentParentId },
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
            const deleteResult = await tx.file.deleteMany({
                where: { id: { in: idsToDelete } }
            });
            console.log(`[API Files] Deleted ${deleteResult.count} record(s) from DB for path ${nodeToDelete.path}`);
            return nodeToDelete;
        });

        const project = await prisma.project.findUnique({ where: { id: deletedNode.projectId }, select: { containerId: true } });
        if (project?.containerId) {
            const container = await getContainerSafely(project.containerId);
            if (container) {
                const inspectData = await container.inspect();
                if (inspectData.State.Running) {
                    const filePathInContainer = deletedNode.path.startsWith('/workspace/')
                        ? deletedNode.path
                        : (deletedNode.path.startsWith('/')
                            ? `/workspace${deletedNode.path}`
                            : `/workspace/${deletedNode.path}`);
                    console.log(`[API Files] Normalized deletion path from ${deletedNode.path} to ${filePathInContainer}`);
                    const cmd = ['rm', '-rf', filePathInContainer];
                    const { success } = await execCmdInContainer(container, cmd, '/'); // Working dir / for absolute path
                    if (!success) {
                        console.warn(`[API Files] Failed to delete ${deletedNode.path} in container ${project.containerId}, but DB record(s) deleted.`);
                    } else {
                        console.log(`[API Files] Successfully deleted ${deletedNode.path} in container ${project.containerId}`);
                    }
                } else { console.warn(`Container ${project.containerId} not running, skipping container deletion.`); }
            } else { console.warn(`Container ${project.containerId} not found or not accessible. Skipping container deletion of ${deletedNode.path}.`);}
        }
        res.status(200).json({ message: 'Item deleted successfully' });
    } catch (error: any) {
        if (error.message === 'NotFound') {
            return res.status(404).json({ message: 'File/Folder not found' });
        }
        console.error(`[API Error] Failed to delete node ${fileId}:`, error);
        next(error);
    }
}

export async function renameFileOrDirectoryHandler(req: Request, res: Response, next: NextFunction) {
    const { fileId } = req.params;
    const { newName } = req.body;

    if (typeof fileId !== 'string' || !fileId) return res.status(400).json({ message: 'Invalid file ID' });
    if (!newName || typeof newName !== 'string' || newName.includes('/') || newName.includes('\\') || newName.trim() === '') return res.status(400).json({ message: 'Invalid new name' });

    const trimmedNewName = newName.trim();
    console.log(`[API Files] Request to rename node ${fileId} to "${trimmedNewName}"`);

    try {
        const { updatedNodeResult, originalPath, originalProjectId } = await prisma.$transaction(async (tx) => {
            const nodeToRename = await tx.file.findUnique({
                where: { id: fileId },
                select: { id: true, name: true, path: true, projectId: true, parentId: true, isDirectory: true }
            });
            if (!nodeToRename) throw new Error('NotFound');
            if (nodeToRename.name === trimmedNewName) throw new Error('SameName');

            const currentOriginalPath = nodeToRename.path;
            const currentOriginalProjectId = nodeToRename.projectId;
            const parentDir = path.dirname(currentOriginalPath).replace(/\\/g, '/');
            const newPath = path.join(parentDir, trimmedNewName).replace(/\\/g, '/');

            const existing = await tx.file.findUnique({
                where: { projectId_path: { projectId: currentOriginalProjectId, path: newPath } }
            });
            if (existing) throw new Error('Conflict');

            const descendantsToUpdate: { id: string, path: string }[] = [];
            if (nodeToRename.isDirectory) {
                const queue: { id: string, path: string }[] = [{ id: nodeToRename.id, path: nodeToRename.path }]; // Simplified queue
                while (queue.length > 0) {
                    const current = queue.shift()!;
                    const children = await tx.file.findMany({
                        where: { parentId: current.id },
                        select: { id: true, path: true, isDirectory: true }
                    });
                    children.forEach(child => {
                        descendantsToUpdate.push({ id: child.id, path: child.path });
                        if (child.isDirectory) queue.push({id: child.id, path: child.path});
                    });
                }
                console.log(`[API Files] Found ${descendantsToUpdate.length} descendants to update path for rename.`);
            }

            const oldPathPrefix = currentOriginalPath + (nodeToRename.isDirectory ? '/' : '');
            const newPathPrefix = newPath + (nodeToRename.isDirectory ? '/' : '');

            for (const descendant of descendantsToUpdate) {
                if (descendant.path.startsWith(oldPathPrefix)) {
                    const updatedDescendantPath = descendant.path.replace(oldPathPrefix, newPathPrefix);
                    await tx.file.update({ where: { id: descendant.id }, data: { path: updatedDescendantPath } });
                } else if (descendant.path === currentOriginalPath && !nodeToRename.isDirectory){
                    // This case should not happen if logic is correct, but as a fallback for files directly.
                    // This part of logic is tricky for just prefix replacement if it's a file.
                    // The main node update handles the file itself.
                }
                 else {
                    console.warn(`[API Files] Descendant path ${descendant.path} did not match prefix ${oldPathPrefix} during rename. Original node was dir: ${nodeToRename.isDirectory}`);
                }
            }

            const finalUpdatedNode = await tx.file.update({
                where: { id: fileId },
                data: { name: trimmedNewName, path: newPath },
                select: { id: true, name: true, path: true, projectId: true, parentId: true, isDirectory: true, createdAt: true, updatedAt: true }
            });
            return {
                updatedNodeResult: finalUpdatedNode,
                originalPath: currentOriginalPath,
                originalProjectId: currentOriginalProjectId
            };
        });

        console.log(`[API Files] Renamed node ${fileId} to "${trimmedNewName}" in DB.`);

        const project = await prisma.project.findUnique({ where: { id: originalProjectId }, select: { containerId: true } });
        if (project?.containerId) {
            const container = await getContainerSafely(project.containerId);
            if (container) {
                const inspectData = await container.inspect();
                if (inspectData.State.Running) {
                    const oldPathForContainer = originalPath;
                    const newPathForContainer = updatedNodeResult.path;
                    // Ensure paths are workspace-relative for the `mv` command if they are not already
                    const finalOldPath = oldPathForContainer.startsWith('/workspace/') ? oldPathForContainer : path.posix.join('/workspace', oldPathForContainer.replace(/^\//, ''));
                    const finalNewPath = newPathForContainer.startsWith('/workspace/') ? newPathForContainer : path.posix.join('/workspace', newPathForContainer.replace(/^\//, ''));

                    const cmd = ['mv', '-T', finalOldPath, finalNewPath];
                    const { success, stderr } = await execCmdInContainer(container, cmd, '/'); // Working dir / for absolute paths
                    if (!success) {
                        console.warn(`[API Files] Failed to rename ${finalOldPath} to ${finalNewPath} in container ${project.containerId}. Error: ${stderr}. DB record(s) updated.`);
                    } else {
                        console.log(`[API Files] Successfully renamed ${finalOldPath} to ${finalNewPath} in container ${project.containerId}`);
                    }
                } else { console.warn(`Container ${project.containerId} not running, skipping container rename.`); }
            } else { console.warn(`Container ${project.containerId} not found or not accessible. Skipping rename of ${originalPath}.`);}
        }

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
}
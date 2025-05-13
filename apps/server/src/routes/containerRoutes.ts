// codeyarn/apps/server/src/routes/containerRoutes.ts
import express, { Router, Request, Response, NextFunction } from 'express';
import Docker from 'dockerode';
import { Template, ContainerStatus, Container } from '@codeyarn/shared-types';
import prisma from '@codeyarn/db'; // Import the Prisma Client instance
import fs from 'fs-extra';
import path from 'path';
import tar from 'tar-fs';
import { Duplex, Readable, PassThrough } from 'stream';
import portfinder from 'portfinder';

// Define a type for the global file watch map
declare global {
  var fileWatchMap: Map<string, number>;
}

// Assume docker instance is passed or imported
const docker = new Docker();

const router: Router = express.Router();


// Path to your scan script within the runner image
const SCAN_SCRIPT_PATH_IN_CONTAINER = '/usr/local/bin/scan-workspace.js'; // Adjust if needed

async function getDockerContainerInstance(containerIdOrName: string): Promise<Docker.Container | null> {
    try {
        const container = docker.getContainer(containerIdOrName);
        await container.inspect();
        return container;
    } catch (error: any) {
        if (error.statusCode === 404) {
            return null;
        }
        console.error(`[Docker Helper] Error inspecting container ${containerIdOrName}:`, error);
        throw error;
    }
}

/**
 * Scans the container's workspace and creates corresponding File records in the database.
 */
async function createFileRecordsFromContainer(
    container: Docker.Container,
    projectId: string
): Promise<void> {
    console.log(`[DB Files] Starting workspace scan for container ${container.id}, project ${projectId}`);
    let fileListJson = '[]';
    try {
        // Check if scan script exists by running a test command
        try {
            const testExec = await container.exec({
                Cmd: ['test', '-f', SCAN_SCRIPT_PATH_IN_CONTAINER],
                AttachStdout: false,
                AttachStderr: false
            });
            await testExec.start({});
        } catch (scriptCheckError) {
            console.warn(`[DB Files] Scan script not found at ${SCAN_SCRIPT_PATH_IN_CONTAINER}. Using default workspace setup.`);
            // Skip the actual scan attempt if the script doesn't exist
            throw new Error('Scan script not found');
        }

        const exec = await container.exec({
            Cmd: ['node', SCAN_SCRIPT_PATH_IN_CONTAINER],
            AttachStdout: true,
            AttachStderr: true, // Capture stderr for debugging scan script issues
            WorkingDir: '/workspace' // Ensure script runs in the correct context
        });
        const stream: Duplex = await exec.start({});

        let stdout = '';
        let stderr = '';
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        stdoutStream.on('data', chunk => stdout += chunk.toString('utf8'));
        stderrStream.on('data', chunk => stderr += chunk.toString('utf8'));

        container.modem.demuxStream(stream, stdoutStream, stderrStream);

        await new Promise<void>((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('error', reject); // Handle stream errors
        });

        const inspectData = await exec.inspect();
        if (inspectData.ExitCode !== 0) {
            console.error(`[DB Files] Scan script in container ${container.id} exited with code ${inspectData.ExitCode}. Stderr: ${stderr.trim()}`);
            // Fallback to empty list, or throw a more specific error if scan is critical
        } else {
            fileListJson = stdout.trim();
            if (stderr.trim()) { // Log stderr even on success, as it might contain warnings from the script
                console.warn(`[DB Files] Scan script in container ${container.id} produced stderr output: ${stderr.trim()}`);
            }
        }
    } catch (error) {
        console.error(`[DB Files] Error executing scan script in container ${container.id}:`, error);
        // Fallback to empty list or throw
    }

    let rawFileEntries: { name: string; path: string; isDirectory: boolean; content?: string }[] = [];
    try {
        rawFileEntries = JSON.parse(fileListJson);
    } catch (e) {
        console.error('[DB Files] Failed to parse file structure JSON from scan script output:', e, 'Raw JSON received:', `"${fileListJson}"`);
        // If JSON is empty or invalid, we might still want to create a root /workspace if it doesn't exist
        if (fileListJson.trim() === "" || fileListJson.trim() === "[]") {
             console.log("[DB Files] Scan script returned empty or no valid JSON. Ensuring /workspace root exists.");
        } else {
            // Only throw if parsing failed on non-empty, non-array JSON
            throw new Error("Failed to parse workspace scan result.");
        }
    }

    // Ensure /workspace root entry exists if not provided by script or if list is empty
    if (!rawFileEntries.some(entry => entry.path === '/workspace')) {
        const workspaceRootExists = await prisma.file.findFirst({
            where: { projectId, path: '/workspace' }
        });
        if (!workspaceRootExists) {
            console.log(`[DB Files] Adding default /workspace root for project ${projectId}`);
            rawFileEntries.unshift({ name: 'workspace', path: '/workspace', isDirectory: true });
        }
    }
    
    if (rawFileEntries.length === 0) {
        console.log(`[DB Files] No files found by scan script for project ${projectId}. Workspace might be empty or scan failed.`);
        return;
    }

    // Sort entries by path depth to ensure parents are created before children
    rawFileEntries.sort((a, b) => a.path.split('/').length - b.path.split('/').length);

    const createdNodesMap = new Map<string, string>(); // Map path to DB File ID

    for (const entry of rawFileEntries) {
        // Normalize path again just in case, ensure leading slash, remove trailing
        let normalizedEntryPath = path.posix.normalize(entry.path);
        if (!normalizedEntryPath.startsWith('/')) normalizedEntryPath = '/' + normalizedEntryPath;
        if (normalizedEntryPath.endsWith('/') && normalizedEntryPath !== '/') normalizedEntryPath = normalizedEntryPath.slice(0, -1);
        if (normalizedEntryPath === "") normalizedEntryPath = "/"; // Should not happen with /workspace base

        const parentDirSystemPath = path.posix.dirname(normalizedEntryPath);
        let parentId: string | null = null;

        if (normalizedEntryPath === '/workspace') { // Special handling for the root /workspace itself
            parentId = null;
        } else if (parentDirSystemPath === '/' || parentDirSystemPath === '/workspace') {
            // Items directly under /workspace. Their parent is /workspace.
            // Ensure /workspace is in the map (should be, from sorting or pre-check)
            parentId = createdNodesMap.get('/workspace') || null;
            if (!parentId) { // Defensive: if /workspace wasn't created/mapped yet
                const rootNode = await prisma.file.findFirst({where: {projectId, path: '/workspace'}});
                if (rootNode) parentId = rootNode.id;
                else console.error(`[DB Files] Critical: /workspace root node not found for parent lookup of ${normalizedEntryPath}`);
            }
        } else {
            parentId = createdNodesMap.get(parentDirSystemPath) || null;
        }

        // Check if file already exists (e.g. if scan script lists /workspace and we also add it)
        const existingFile = await prisma.file.findFirst({
            where: { projectId, path: normalizedEntryPath }
        });

        if (existingFile) {
            if (!createdNodesMap.has(normalizedEntryPath)) {
                createdNodesMap.set(normalizedEntryPath, existingFile.id);
            }
            console.log(`[DB Files] File record for ${normalizedEntryPath} already exists. ID: ${existingFile.id}`);
            continue;
        }
        
        try {
            const fileRecord = await prisma.file.create({
                data: {
                    name: entry.name,
                    path: normalizedEntryPath,
                    isDirectory: entry.isDirectory,
                    projectId: projectId,
                    parentId: parentId,
                    content: entry.content || null, // Use content from scan script if available
                }
            });
            createdNodesMap.set(normalizedEntryPath, fileRecord.id);
            console.log(`[DB Files] Created DB record for ${normalizedEntryPath} (ID: ${fileRecord.id}, ParentID: ${parentId})`);
        } catch (dbError: any) {
            console.error(`[DB Files] Failed to create DB record for ${normalizedEntryPath} in project ${projectId}. ParentPath: ${parentDirSystemPath}, Resolved ParentID: ${parentId}. Error:`, dbError.message);
            // Optionally, log more details like entry itself
        }
    }
    console.log(`[DB Files] Created/verified ${createdNodesMap.size} DB file records for project ${projectId}`);
}


/**
 * Populates a container's workspace with template files
 * and creates corresponding file records in the database.
 */
async function populateWorkspaceAndCreateDbFilesImpl(
    container: Docker.Container,
    projectId: string,
    template: Pick<Template, 'id'> & { sourceHostPath?: string | null }
): Promise<void> {
    console.log(`[WorkspacePopulation] Starting for project ${projectId}, template ${template.id}`);
    const containerId = container.id;

    if (!template.sourceHostPath) {
        console.warn(`[WorkspacePopulation] Template ${template.id} has no sourceHostPath. Skipping file copy.`);
    } else {
        if (!template.sourceHostPath || !(await fs.pathExists(template.sourceHostPath)) || !(await fs.stat(template.sourceHostPath)).isDirectory()) {
            console.error(`[WorkspacePopulation] Template source path invalid: ${template.sourceHostPath}`);
            throw new Error(`Template source path invalid or not a directory: ${template.sourceHostPath}`);
        }
        try {
            console.log(`[WorkspacePopulation] Creating tar from: ${template.sourceHostPath}`);
            const tarStream = tar.pack(template.sourceHostPath);
            await container.putArchive(tarStream, { path: '/workspace/' }); // Extracts content into /workspace
            console.log(`[WorkspacePopulation] Copied files from ${template.sourceHostPath} to ${containerId}:/workspace/`);
        } catch (error) {
            console.error(`[WorkspacePopulation] Error copying template files to ${containerId}:`, error);
            throw new Error('Failed to copy template files into workspace.');
        }
    }
    // After files are (potentially) copied, scan and create DB records
    await createFileRecordsFromContainer(container, projectId);
    console.log(`[WorkspacePopulation] Completed for project ${projectId}`);
}

/**
 * POST /api/containers
 * Creates or retrieves an existing container for a project.
 * Populates workspace from template if creating for the first time for this project.
 */


router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const { projectId, templateId } = req.body;

    if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ message: 'Missing or invalid projectId' });
    }
    if (!templateId || typeof templateId !== 'string') {
        return res.status(400).json({ message: 'Missing or invalid templateId' });
    }

    console.log(`[API Containers] Request: Project ${projectId}, Template ${templateId}`);
    let wasNewContainerActuallyCreated = false; // Renamed for clarity
    let containerIdForCleanup: string | null = null; // For potential cleanup in main catch

    try {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true, templateId: true, containerId: true }
        });

        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        const template = await prisma.template.findUnique({
            where: { id: templateId },
            select: { id: true, name: true, dockerImage: true, sourceHostPath: true, startCommand: true, defaultPort: true }
        });

        if (!template || !template.dockerImage) {
            return res.status(404).json({ message: 'Template not found or dockerImage not specified.' });
        }
        if (!template.defaultPort) {
            return res.status(400).json({ message: `Template ${templateId} is missing defaultPort.` });
        }
        console.log(`[API Containers] Using Template: ${template.name}, Image: ${template.dockerImage}, StartCmd: ${template.startCommand}, Port: ${template.defaultPort}, SourcePath: ${template.sourceHostPath}`);

        let dbContainerRecord = await prisma.container.findUnique({
            where: { projectId: projectId },
            select: { id: true, status: true, hostPort: true, internalPort: true, projectId: true, templateId: true, createdAt: true, startedAt: true, stoppedAt: true }
        });

        let dockerContainerInstance: Docker.Container | null = null;
        let finalHostPortToUseInResponse: number | null = null;

        if (dbContainerRecord && dbContainerRecord.id) {
            containerIdForCleanup = dbContainerRecord.id; // Existing container ID for potential cleanup
            console.log(`[API Containers] Existing DB container record found: ${dbContainerRecord.id}. Verifying Docker state.`);
            dockerContainerInstance = await getDockerContainerInstance(dbContainerRecord.id);

            if (dockerContainerInstance) {
                let inspectInfo = await dockerContainerInstance.inspect();
                finalHostPortToUseInResponse = dbContainerRecord.hostPort; // Trust DB for existing

                if (templateId !== dbContainerRecord.templateId) {
                    console.warn(`[API Containers] Template ID mismatch for existing container (Project: ${projectId}, Old: ${dbContainerRecord.templateId}, New: ${templateId}). Removing old container to recreate.`);
                    await dockerContainerInstance.remove({ force: true }).catch(e => console.error(`[API Containers] Failed to remove container for template change: ${e.message}`));
                    await prisma.container.delete({ where: { id: dbContainerRecord.id }});
                    dbContainerRecord = null; // Force recreation
                    dockerContainerInstance = null; // Nullify instance
                } else if (!inspectInfo.State.Running) {
                    console.log(`[API Containers] Existing container ${dbContainerRecord.id} is stopped. Starting...`);
                    try {
                        await dockerContainerInstance.start();
                        inspectInfo = await dockerContainerInstance.inspect(); // Re-inspect
                        console.log(`[API Containers] Started existing container ${dbContainerRecord.id}.`);
                        if (dbContainerRecord.status !== 'RUNNING' || !inspectInfo.State.StartedAt) {
                            dbContainerRecord = await prisma.container.update({
                                where: { id: dbContainerRecord.id },
                                data: { status: 'RUNNING', startedAt: new Date(inspectInfo.State.StartedAt) },
                                select: { id: true, status: true, hostPort: true, internalPort: true, projectId: true, templateId: true, createdAt: true, startedAt: true, stoppedAt: true }
                            });
                        }
                    } catch (startError: any) {
                        console.error(`[API Containers] Failed to start existing container ${dbContainerRecord.id}: ${startError.message}. Removing & recreating.`);
                        await dockerContainerInstance.remove({ force: true }).catch(e => console.error(`[API Containers] Cleanup failed for non-starting container ${dockerContainerInstance?.id}: ${e.message}`));
                        await prisma.container.delete({ where: { id: dbContainerRecord.id }});
                        dbContainerRecord = null;
                        dockerContainerInstance = null;
                    }
                }
            } else {
                console.warn(`[API Containers] DB record for ${dbContainerRecord.id} exists, but Docker container not found. Cleaning DB, will recreate.`);
                await prisma.container.delete({ where: { id: dbContainerRecord.id }});
                dbContainerRecord = null;
            }
        }

        if (!dbContainerRecord) {
            wasNewContainerActuallyCreated = true;
            console.log(`[API Containers] Creating new container for project ${projectId}.`);
            
            let allocatedHostPort: number;
            try {
                portfinder.basePort = 32000;
                allocatedHostPort = await portfinder.getPortPromise();
                console.log(`[API Containers] Allocated hostPort via portfinder: ${allocatedHostPort}`);
            } catch (portError: any) {
                console.error(`[API Containers] Portfinder error for project ${projectId}:`, portError.message);
                return next(new Error('Could not allocate a free port.'));
            }
            
            finalHostPortToUseInResponse = allocatedHostPort;

            const volumeName = `codeyarn-vol-${projectId}`;
            try {
                await docker.createVolume({ Name: volumeName });
            } catch (volumeError: any) {
                if (volumeError.statusCode !== 409) { // 409 is "conflict"/already exists
                    console.error(`[API Containers] Error creating volume ${volumeName}:`, volumeError.message);
                    return next(new Error(`Volume creation failed: ${volumeError.message}`));
                }
            }
            console.log(`[API Containers] Ensured volume exists: ${volumeName}`);

            const containerName = `codeyarn-session-${projectId}`;
            const existingNamedContainer = await getDockerContainerInstance(containerName);
            if (existingNamedContainer) {
                console.warn(`[API Containers] Removing existing container with conflicting name ${containerName}.`);
                await existingNamedContainer.remove({ force: true }).catch(e => console.error(`[API Containers] Failed to remove conflicting container ${containerName}: ${e.message}`));
            }
            
            const assetPrefix = `/preview/container/${finalHostPortToUseInResponse}`;
            console.log(`[API Containers] Setting ASSET_PREFIX: ${assetPrefix}`);
            
            const containerOptions: Docker.ContainerCreateOptions = {
                Image: template.dockerImage, name: containerName, Tty: true, AttachStdin: false, AttachStdout: true, AttachStderr: true, OpenStdin: false,
                WorkingDir: process.env.CONTAINER_WORKSPACE || '/workspace',
                HostConfig: {
                    Binds: [`${volumeName}:${process.env.CONTAINER_WORKSPACE || '/workspace'}`],
                    AutoRemove: false,
                    PortBindings: template.defaultPort ? { [`${template.defaultPort}/tcp`]: [{ HostPort: finalHostPortToUseInResponse.toString() }] } : undefined,
                    ExtraHosts: ['host.docker.internal:host-gateway']
                },
                Labels: { 'codeyarn.project.id': projectId, 'codeyarn.template.id': templateId },
                Env: [
                    `PROJECT_ID=${projectId}`, `NODE_ENV=development`, `PORT=${template.defaultPort}`,
                    `WATCH_PATH=/workspace`, `BACKEND_HOST=${process.env.WATCHER_CALLBACK_HOST || 'host.docker.internal'}`,
                    `BACKEND_PORT=${process.env.PORT || 3001}`, `BACKEND_ENDPOINT=/api/internal/filesystem-event`,
                    `ASSET_PREFIX=${assetPrefix}`, `NEXT_PUBLIC_ASSET_PREFIX=${assetPrefix}`
                ],
                User: process.env.CONTAINER_USER || 'coder',
                Cmd: template.startCommand ? (template.startCommand.startsWith('/') ? [template.startCommand] : template.startCommand.split(' ')) : undefined,
            };

            try {
                dockerContainerInstance = await docker.createContainer(containerOptions);
                containerIdForCleanup = dockerContainerInstance.id; // Set for potential cleanup in main catch
                await dockerContainerInstance.start();
                const inspectInfo = await dockerContainerInstance.inspect();
                console.log(`[API Containers] New container ${inspectInfo.Id} started. Requested HostPort: ${finalHostPortToUseInResponse}.`);

                // Verify actual bound port matches requested port
                const internalPortKey = template.defaultPort ? `${template.defaultPort}/tcp` : undefined;
                const portBindingsFromInspect = inspectInfo.NetworkSettings.Ports;
                let actualBoundHostPort: number | null = null;
                if (internalPortKey && portBindingsFromInspect && portBindingsFromInspect[internalPortKey]?.[0]?.HostPort) {
                    actualBoundHostPort = parseInt(portBindingsFromInspect[internalPortKey][0].HostPort);
                }
                if (actualBoundHostPort !== finalHostPortToUseInResponse) {
                    const portMismatchError = `CRITICAL PORT MISMATCH: Requested ${finalHostPortToUseInResponse}, Docker bound to ${actualBoundHostPort}. ASSET_PREFIX will be incorrect.`;
                    console.error(`[API Containers] ${portMismatchError}`);
                    await dockerContainerInstance.remove({ force: true }).catch(e => console.error(`[API Containers] Cleanup failed for misconfigured container ${containerIdForCleanup}: ${e.message}`));
                    return next(new Error(portMismatchError)); 
                }

            } catch (creationError: any) {
                 console.error(`[API Containers] Error creating/starting container for project ${projectId}: ${creationError.message}`, creationError);
                 if (dockerContainerInstance && containerIdForCleanup) { // If create succeeded but start/inspect failed
                    await dockerContainerInstance.remove({ force: true }).catch(e => console.error(`[API Containers] Cleanup attempt failed for container ${containerIdForCleanup}: ${e.message}`));
                 }
                 return next(new Error(`Container creation/start failed: ${creationError.message}`));
            }
            
            // populateWorkspaceAndCreateDbFilesImpl handles its own console logs
            if (dockerContainerInstance) {
                 await populateWorkspaceAndCreateDbFilesImpl(dockerContainerInstance, projectId, {
                    id: template.id,
                    sourceHostPath: template.sourceHostPath // Will be null for Next.js/node-basic
                });
            } else {
                // Should have been caught by error handling above
                throw new Error("Docker container instance was not available for workspace population.");
            }

            const finalInspectInfo = await docker.getContainer(containerIdForCleanup!).inspect();
            const containerDataForDb = {
                id: finalInspectInfo.Id,
                status: (finalInspectInfo.State.Running ? 'RUNNING' : finalInspectInfo.State.Status.toUpperCase()) as ContainerStatus,
                hostPort: finalHostPortToUseInResponse,
                internalPort: template.defaultPort,
                projectId: projectId,
                templateId: templateId,
                startedAt: finalInspectInfo.State.Running && finalInspectInfo.State.StartedAt ? new Date(finalInspectInfo.State.StartedAt) : null,
                createdAt: new Date(finalInspectInfo.Created)
            };
            dbContainerRecord = await prisma.container.create({
                data: containerDataForDb,
                select: { id: true, status: true, hostPort: true, internalPort: true, projectId: true, templateId: true, createdAt: true, startedAt: true, stoppedAt: true }
            });
            console.log(`[API Containers] New DB record for container ${dbContainerRecord.id} created with hostPort ${dbContainerRecord.hostPort}`);
        }

        if (!dbContainerRecord || !dbContainerRecord.id) {
            throw new Error("Container DB record could not be established or found.");
        }
        
        if (project.containerId !== dbContainerRecord.id) {
            await prisma.project.update({
                where: { id: projectId },
                data: { containerId: dbContainerRecord.id },
            });
            console.log(`[API Containers] Project ${projectId} linked to container ID ${dbContainerRecord.id}.`);
        }

        const responseContainerData: Container = { // Use imported 'Container' type
            id: dbContainerRecord.id,
            projectId: dbContainerRecord.projectId,
            templateId: dbContainerRecord.templateId,
            status: dbContainerRecord.status,
            hostPort: dbContainerRecord.hostPort,
            // internalPort: dbContainerRecord.internalPort, // Uncomment if in your SharedContainerType
            createdAt: dbContainerRecord.createdAt.toISOString(),
            startedAt: dbContainerRecord.startedAt ? dbContainerRecord.startedAt.toISOString() : undefined,
            stoppedAt: dbContainerRecord.stoppedAt ? dbContainerRecord.stoppedAt.toISOString() : undefined
        };
        res.status(wasNewContainerActuallyCreated ? 201 : 200).json(responseContainerData);

    } catch (error: any) {
        console.error(`[API Containers] General Error in POST / (Project: ${projectId}, Template: ${templateId}):`, error.message, error.stack);
        if (wasNewContainerActuallyCreated && containerIdForCleanup) {
             console.log(`[API Containers] Error occurred. Attempting cleanup for Docker container ${containerIdForCleanup}.`);
             try {
                const containerToClean = docker.getContainer(containerIdForCleanup);
                await containerToClean.remove({ force: true }).catch(() => {});
                console.log(`[API Containers] Cleaned up Docker container ${containerIdForCleanup}.`);
             } catch (cleanupError: any) {
                if (cleanupError.statusCode !== 404) {
                     console.error(`[API Containers] Error during cleanup of Docker container ${containerIdForCleanup}:`, cleanupError.message);
                }
             }
        }
        next(error);
    }
});


/**
 * POST /api/containers/:id/start
 * Starts an existing stopped container and updates DB.
 */
router.post('/:id/start', async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    console.log(`[API Containers] Request received to start container: ${id}`);

    try {
        // Check DB first
        const dbContainer = await prisma.container.findUnique({ where: { id } });
        if (!dbContainer) {
             console.warn(`[API Containers] Container ${id} not found in database.`);
             // Maybe check Docker anyway? Or return 404?
             return res.status(404).json({ message: 'Container record not found' });
        }
        if (dbContainer.status === 'RUNNING') {
             console.log(`[API Containers] Container ${id} already marked as running in DB.`);
             return res.status(200).json({
                message: 'Container is already running', containerId: id, status: 'RUNNING',
                hostPort: dbContainer.hostPort,
            });
        }
        if (dbContainer.status === 'DELETED') {
            console.warn(`[API Containers] Attempt to start a deleted container record: ${id}`);
            return res.status(404).json({ message: 'Container has been deleted' });
        }


        const container = await getDockerContainerInstance(id);
        if (!container) {
            // Discrepancy: In DB but not in Docker
            console.error(`[API Error] Container ${id} found in DB but not in Docker!`);
            // Update DB status to ERROR or DELETED?
            await prisma.container.update({ where: { id }, data: { status: 'ERROR' }}); // Or DELETED
            return res.status(404).json({ message: 'Container not found in Docker engine' });
        }

        const inspectDataBefore = await container.inspect();
        if (inspectDataBefore.State.Running) {
            console.warn(`[API Containers] Container ${id} is running in Docker but DB status was ${dbContainer.status}. Updating DB.`);
            // Update DB if inconsistent
            await prisma.container.update({ where: { id }, data: { status: 'RUNNING', startedAt: new Date() }});
             return res.status(200).json({
                message: 'Container is already running (DB updated)', containerId: id, status: 'RUNNING',
                hostPort: dbContainer.hostPort,
            });
        }

        await container.start();
        console.log(`[API Containers] Container started: ${id}`);

        // Update DB status
        await prisma.container.update({
            where: { id },
            data: { status: 'RUNNING', startedAt: new Date() }
        });

        res.status(200).json({
            message: 'Container started successfully', containerId: id, status: 'RUNNING',
            hostPort: dbContainer.hostPort,
        });

    } catch (error: any) {
        console.error(`[API Error] Failed to start container ${id}:`, error);
         // Update DB status to ERROR if start failed
         await prisma.container.update({
            where: { id },
            data: { status: 'ERROR' }
         }).catch(dbErr => console.error(`[API Error] Failed to update DB status to ERROR for ${id}`, dbErr));
        next(error);
    }
});

/**
 * POST /api/containers/:id/stop
 * Stops a running container and updates DB.
 */
router.post('/:id/stop', async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    const timeout = req.query.timeout ? parseInt(req.query.timeout as string, 10) : 10;
    console.log(`[API Containers] Request received to stop container: ${id} (timeout: ${timeout}s)`);

    try {
        const container = await getDockerContainerInstance(id);
        let dbStatusUpdate: ContainerStatus = 'STOPPED';

        if (!container) {
            console.warn(`[API Containers] Container ${id} not found in Docker during stop request.`);
            // Update DB if it wasn't already stopped/deleted
            const dbContainer = await prisma.container.findUnique({ where: { id } });
            if (dbContainer && dbContainer.status !== 'STOPPED' && dbContainer.status !== 'DELETED') {
                await prisma.container.update({ where: { id }, data: { status: 'STOPPED', stoppedAt: new Date() } }); // Or DELETED?
                console.log(`[API Containers] Updated DB status for ${id} to STOPPED as container not found in Docker.`);
            }
            // Respond based on whether we knew about it
            return res.status(dbContainer ? 200 : 404).json({
                message: dbContainer ? 'Container already stopped or removed' : 'Container not found',
                containerId: id,
                status: 'STOPPED'
            });
        }

        const inspectData = await container.inspect();
        if (!inspectData.State.Running) {
            console.log(`[API Containers] Container ${id} is already stopped in Docker.`);
            dbStatusUpdate = 'STOPPED'; // Ensure DB is marked stopped
        } else {
            // Stop the container
            await container.stop({ t: timeout });
            console.log(`[API Containers] Container stopped: ${id}`);
            dbStatusUpdate = 'STOPPED';
        }

        // Update DB status
        await prisma.container.update({
            where: { id },
            data: { status: dbStatusUpdate, stoppedAt: new Date() }
        });

        res.status(200).json({ message: 'Container stopped successfully', containerId: id, status: 'STOPPED' });

    } catch (error: any) {
        console.error(`[API Error] Failed to stop container ${id}:`, error);
        if (error.statusCode === 304) { // Already stopped
             console.log(`[API Containers] Container ${id} reported as already stopped (304). Updating DB.`);
             await prisma.container.update({
                 where: { id }, data: { status: 'STOPPED', stoppedAt: new Date() }
             }).catch(dbErr => console.error(`[API Error] Failed to update DB status for ${id} after 304 error`, dbErr));
             return res.status(200).json({ message: 'Container was already stopped', containerId: id, status: 'STOPPED' });
        }
        // Mark as ERROR in DB if stop failed unexpectedly
        await prisma.container.update({
            where: { id }, data: { status: 'ERROR' }
        }).catch(dbErr => console.error(`[API Error] Failed to update DB status to ERROR for ${id} after stop failure`, dbErr));
        next(error);
    }
});

/**
 * DELETE /api/containers/:id
 * Stops (if needed) and removes a container, updates DB.
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    const force = req.query.force === 'true';
    console.log(`[API Containers] Request received to delete container: ${id} (force: ${force})`);

    try {
        const container = await getDockerContainerInstance(id);

        if (container) {
            // If container exists in Docker, remove it
            await container.remove({ force: force });
            console.log(`[API Containers] Container removed from Docker: ${id}`);
        } else {
            console.log(`[API Containers] Container ${id} not found in Docker during delete request.`);
        }

        // Update DB status to DELETED regardless of Docker state (if record exists)
        const updatedDb = await prisma.container.update({
            where: { id },
            data: { status: 'DELETED', hostPort: null, stoppedAt: new Date() } // Clear port, mark deleted
        }).catch(err => {
            // Handle case where DB record might not exist (e.g., already deleted)
            if (err.code === 'P2025') { // Prisma code for Record to update not found
                console.log(`[API Containers] DB record for ${id} not found during delete.`);
                return null; // Indicate record wasn't found/updated
            }
            throw err; // Rethrow other DB errors
        });

        if (updatedDb) {
            console.log(`[API Containers] Marked container record as DELETED in DB: ${id}`);
             // Also unlink from project
             await prisma.project.update({
                where: { id: updatedDb.projectId },
                data: { containerId: null }
            }).catch(err => console.error(`[API Error] Failed to unlink container ${id} from project ${updatedDb.projectId}`, err));
        }


        res.status(200).json({ message: 'Container removed successfully', containerId: id, status: 'DELETED' });

    } catch (error: any) {
        console.error(`[API Error] Failed to remove container ${id}:`, error);
        // If Docker remove failed, should we still mark DB as deleted? Maybe ERROR?
        // For now, let generic handler catch it. Consider more specific DB updates on failure.
        next(error);
    }
});

/**
 * GET /api/containers/:id/status
 * Gets the current status of a container from DB, syncing with Docker state if possible.
 */
router.get('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    console.log(`[API Containers] Request received for status of container: ${id}`);

    try {
        let finalStatus: ContainerStatus;
        let dockerState: Docker.ContainerInspectInfo['State'] | undefined = undefined;
        let hostPort: number | null = null;

        // Get DB record first as source of truth
        const dbContainer = await prisma.container.findUnique({ where: { id } });

        if (!dbContainer || dbContainer.status === 'DELETED') {
            console.log(`[API Containers] Container ${id} not found or marked deleted in DB.`);
            return res.status(404).json({ message: 'Container not found or deleted' });
        }

        hostPort = dbContainer.hostPort; // Get port from DB record

        // Now try to sync with Docker state if DB status suggests it might be running/stopped/unknown
        if (dbContainer.status === 'RUNNING' || dbContainer.status === 'STOPPED' || dbContainer.status === 'UNKNOWN' || dbContainer.status === 'CREATING' || dbContainer.status === 'ERROR') {
            const container = await getDockerContainerInstance(id);
            if (!container) {
                // Discrepancy: DB thinks it exists, but Docker says no
                console.warn(`Container ${id} found in DB (status: ${dbContainer.status}) but not in Docker. Updating DB status.`);
                finalStatus = 'DELETED'; // Or maybe ERROR? Let's mark DELETED for consistency
                await prisma.container.update({ where: { id }, data: { status: finalStatus, stoppedAt: new Date() } });
            } else {
                // Container found in Docker, get its actual state
                const inspectData = await container.inspect();
                dockerState = inspectData.State;
                const currentDockerStatus: ContainerStatus = dockerState.Running ? 'RUNNING' :
                                                             dockerState.Status === 'exited' ? 'STOPPED' :
                                                             'UNKNOWN';

                finalStatus = currentDockerStatus; // Trust Docker's current state

                // Update DB if inconsistent
                if (dbContainer.status !== finalStatus) {
                    console.log(`[API Containers] Updating DB status for ${id} from ${dbContainer.status} to ${finalStatus} based on Docker state.`);
                    await prisma.container.update({
                        where: { id },
                        data: {
                            status: finalStatus,
                            // Update timestamps based on state transition
                            ...(finalStatus === 'RUNNING' && !dbContainer.startedAt ? { startedAt: new Date() } : {}),
                            ...(finalStatus === 'STOPPED' && !dbContainer.stoppedAt ? { stoppedAt: new Date() } : {}),
                        }
                    });
                }
            }
        } else {
            // DB status is CREATING, ERROR, or DELETED - trust DB status for now
            finalStatus = dbContainer.status;
        }

        res.status(200).json({
            containerId: id,
            status: finalStatus,
            dockerState: dockerState, // Send detailed Docker state if available
            hostPort: hostPort // Return known port from DB
        });

    } catch (error: any) {
        console.error(`[API Error] Failed to get status for container ${id}:`, error);
        next(error);
    }
});

/**
 * GET /api/containers/:id/preview-details
 * Gets the necessary details to construct the preview URL.
 */
router.get('/:id/preview-details', async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    console.log(`[API Containers] Request received for preview details of container: ${id}`);

    try {
        // Fetch container details from the database
        const dbContainer = await prisma.container.findUnique({
            where: { id },
            select: { // Select only the fields needed
                status: true,
                hostPort: true,
                internalPort: true,
            }
        });

        if (!dbContainer) {
            return res.status(404).json({ message: 'Container record not found' });
        }

        // Only provide details if the container is expected to be running or starting
        if (dbContainer.status !== 'RUNNING' && dbContainer.status !== 'CREATING') {
            console.log(`[API Containers] Preview requested for non-running container ${id} (status: ${dbContainer.status})`);
            return res.status(409).json({ // 409 Conflict might be appropriate
                message: `Container is not running (status: ${dbContainer.status})`,
                status: dbContainer.status
            });
        }

        if (!dbContainer.hostPort) {
            console.warn(`[API Containers] Preview requested for container ${id}, but hostPort is not set.`);
            return res.status(409).json({
                message: 'Container is running but host port information is missing.',
                status: dbContainer.status
            });
        }

        // --- VVVVV ADDED DEBUG LINES VVVVV ---
        console.log('--- DEBUG START: Preview URL Generation ---');
        console.log('req.protocol:', req.protocol); // Should be 'https' if trust proxy is working
        console.log('req.hostname:', req.hostname); // Should be 'codeyarn.xyz' if trust proxy is working
        console.log('req.headers.host:', req.headers.host); // Original Host header from Nginx
        console.log('req.headers["x-forwarded-proto"]:', req.headers['x-forwarded-proto']); // Header from Nginx
        console.log('req.headers["x-forwarded-host"]:', req.headers['x-forwarded-host']); // Alternative host header from Nginx
        console.log('req.socket.remoteAddress:', req.socket.remoteAddress); // Should be Nginx's IP or ::1/127.0.0.1
        console.log('--- DEBUG END: Preview URL Generation ---');
        // --- ^^^^^ ADDED DEBUG LINES ^^^^^ ---

        // Your existing logic to determine protocol and domain:
        // Safely get the domain, ensuring it's always a string
        // With 'trust proxy' set, req.hostname should ideally give the correct domain.
        // req.headers.host might be what Nginx passed, which should be the original host.
        const domain = req.hostname && req.hostname !== 'localhost' // Prefer req.hostname if available and not localhost
            ? req.hostname
            : (req.headers.host && typeof req.headers.host === 'string'
                ? req.headers.host.split(':')[0]
                : 'codeyarn.xyz'); // Fallback

        // Extract protocol from request.
        // With 'trust proxy' set, req.protocol should give the X-Forwarded-Proto value.
        let protocol = req.protocol; // Directly use req.protocol

        // Ensure it's a valid protocol, defaulting to https for safety if something is unexpected,
        // especially if the domain is not localhost.
        if (protocol !== 'http' && protocol !== 'https') {
            protocol = 'https';
        }
        if (domain !== 'localhost' && protocol === 'http') { // Upgrade to https for the public domain
             protocol = 'https';
        }


        // Use the domain directly without the API port
        const previewUrl = `${protocol}://${domain}/preview/container/${dbContainer.hostPort}/`;

        console.log(`[API Containers] Generated previewUrl: ${previewUrl}`); // Log the generated URL

        res.status(200).json({
            containerId: id,
            status: dbContainer.status,
            hostPort: dbContainer.hostPort,
            internalPort: dbContainer.internalPort,
            previewUrl: previewUrl
        });

    } catch (error: any) {
        console.error(`[API Error] Failed to get preview details for container ${id}:`, error);
        next(error);
    }
});
/**
 * GET /api/containers/:id/file-status
 * Checks if files in the container have changed since the last check
 */
router.get('/:id/file-status', async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    
    try {
        // Get the container and project information
        const container = await prisma.container.findUnique({
            where: { id },
            select: {
                id: true,
                projectId: true,
                status: true
            }
        });
        
        if (!container) {
            return res.status(404).json({ message: 'Container not found' });
        }
        
        // Get Docker container instance
        const dockerContainer = await getDockerContainerInstance(id);
        if (!dockerContainer) {
            return res.status(404).json({ message: 'Docker container not found' });
        }
        
        // Use exec to check file modification times inside the container
        // For nodebasic template, specifically check index.js
        const exec = await dockerContainer.exec({
            Cmd: ['stat', '-c', '%Y', '/workspace/index.js'],
            AttachStdout: true,
            AttachStderr: true
        });
        
        const stream = await exec.start({});
        let output = '';
        
        // Set up output streams
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        stdoutStream.on('data', (chunk) => {
            output += chunk.toString('utf8');
        });
        
        dockerContainer.modem.demuxStream(stream, stdoutStream, stderrStream);
        
        await new Promise<void>((resolve) => {
            stream.on('end', resolve);
        });
        
        // Get the modification timestamp
        const modTime = parseInt(output.trim());
        
        // Store and compare with last check time using a global map
        // This would ideally be in a database or Redis in production
        if (!global.fileWatchMap) {
            global.fileWatchMap = new Map<string, number>();
        }
        
        const lastModTime = global.fileWatchMap.get(id) || 0;
        const hasChanged = modTime > lastModTime;
        
        // Update the last mod time if changed
        if (hasChanged) {
            global.fileWatchMap.set(id, modTime);
            console.log(`[API Containers] File changes detected in container ${id}`);
        }
        
        res.status(200).json({
            containerId: id,
            filesChanged: hasChanged,
            lastChecked: new Date().toISOString()
        });
        
    } catch (error: any) {
        console.error(`[API Error] Failed to check file status for container ${id}:`, error);
        // Return false instead of error to avoid breaking the frontend polling
        res.status(200).json({
            containerId: id,
            filesChanged: false,
            error: error.message,
            lastChecked: new Date().toISOString()
        });
    }
});

export default router;

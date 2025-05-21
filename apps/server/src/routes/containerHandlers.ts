// src/routes/containerHandlers.ts
import { Request, Response, NextFunction } from 'express';
import Docker from 'dockerode'; // For Docker.ContainerInspectInfo type hint
import prisma from '@codeyarn/db';
import portfinder from 'portfinder';
import { PassThrough } from 'stream';
import { ContainerStatus, Container as SharedContainer } from '@codeyarn/shared-types';
import {
    docker,
    getDockerContainerInstance,
    populateWorkspaceAndCreateDbFilesImpl
} from './containerUtils';

// Define a type for the global file watch map for getFileStatusHandler
declare global {
    var fileWatchMap: Map<string, number>;
}
if (!global.fileWatchMap) {
    global.fileWatchMap = new Map<string, number>();
}


export async function createOrRetrieveContainerHandler(req: Request, res: Response, next: NextFunction) {
    const { projectId, templateId } = req.body;

    if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ message: 'Missing or invalid projectId' });
    }
    if (!templateId || typeof templateId !== 'string') {
        return res.status(400).json({ message: 'Missing or invalid templateId' });
    }

    console.log(`[API Containers] Request: Project ${projectId}, Template ${templateId}`);
    let wasNewContainerActuallyCreated = false;
    let containerIdForCleanup: string | null = null;

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
            select: {
                id: true, name: true, dockerImage: true, sourceHostPath: true,
                startCommand: true, defaultPort: true
            }
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
            select: {
                id: true, status: true, hostPort: true, internalPort: true, projectId: true,
                templateId: true, createdAt: true, startedAt: true, stoppedAt: true
            }
        });

        let dockerContainerInstance: Docker.Container | null = null;
        let finalHostPortToUseInResponse: number | null = null;

        if (dbContainerRecord && dbContainerRecord.id) {
            containerIdForCleanup = dbContainerRecord.id;
            console.log(`[API Containers] Existing DB container record found: ${dbContainerRecord.id}. Verifying Docker state.`);
            dockerContainerInstance = await getDockerContainerInstance(dbContainerRecord.id);

            if (dockerContainerInstance) {
                let inspectInfo = await dockerContainerInstance.inspect();
                finalHostPortToUseInResponse = dbContainerRecord.hostPort;

                if (templateId !== dbContainerRecord.templateId) {
                    console.warn(`[API Containers] Template ID mismatch for existing container (Project: ${projectId}, Old: ${dbContainerRecord.templateId}, New: ${templateId}). Removing old container to recreate.`);
                    await dockerContainerInstance.remove({ force: true }).catch(e => console.error(`[API Containers] Failed to remove container for template change: ${e.message}`));
                    await prisma.container.delete({ where: { id: dbContainerRecord.id } });
                    dbContainerRecord = null;
                    dockerContainerInstance = null;
                } else if (!inspectInfo.State.Running) {
                    console.log(`[API Containers] Existing container ${dbContainerRecord.id} is stopped. Starting...`);
                    try {
                        await dockerContainerInstance.start();
                        inspectInfo = await dockerContainerInstance.inspect();
                        console.log(`[API Containers] Started existing container ${dbContainerRecord.id}.`);
                        if (dbContainerRecord.status !== 'RUNNING' || !inspectInfo.State.StartedAt) {
                            dbContainerRecord = await prisma.container.update({
                                where: { id: dbContainerRecord.id },
                                data: { status: 'RUNNING', startedAt: new Date(inspectInfo.State.StartedAt) },
                                select: {id: true, status: true, hostPort: true, internalPort: true, projectId: true, templateId: true, createdAt: true, startedAt: true, stoppedAt: true}
                            });
                        }
                    } catch (startError: any) {
                        console.error(`[API Containers] Failed to start existing container ${dbContainerRecord.id}: ${startError.message}. Removing & recreating.`);
                        await dockerContainerInstance.remove({ force: true }).catch(e => console.error(`[API Containers] Cleanup failed for non-starting container ${dockerContainerInstance?.id}: ${e.message}`));
                        await prisma.container.delete({ where: { id: dbContainerRecord.id } });
                        dbContainerRecord = null;
                        dockerContainerInstance = null;
                    }
                }
            } else {
                console.warn(`[API Containers] DB record for ${dbContainerRecord.id} exists, but Docker container not found. Cleaning DB, will recreate.`);
                await prisma.container.delete({ where: { id: dbContainerRecord.id } });
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
                if (volumeError.statusCode !== 409) {
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
                Image: template.dockerImage,
                name: containerName,
                Tty: true,
                AttachStdin: false, AttachStdout: true, AttachStderr: true, OpenStdin: false,
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
                    `WATCH_PATH=/workspace`,
                    `BACKEND_HOST=${process.env.WATCHER_CALLBACK_HOST || 'host.docker.internal'}`,
                    `BACKEND_PORT=${process.env.PORT || 3001}`,
                    `BACKEND_ENDPOINT=/api/internal/filesystem-event`,
                    `ASSET_PREFIX=${assetPrefix}`,
                    `NEXT_PUBLIC_ASSET_PREFIX=${assetPrefix}`
                ],
                User: process.env.CONTAINER_USER || 'coder',
                Cmd: template.startCommand ? (template.startCommand.startsWith('/') ? [template.startCommand] : template.startCommand.split(' ')) : undefined,
            };

            try {
                dockerContainerInstance = await docker.createContainer(containerOptions);
                containerIdForCleanup = dockerContainerInstance.id;
                await dockerContainerInstance.start();
                const inspectInfo = await dockerContainerInstance.inspect();
                console.log(`[API Containers] New container ${inspectInfo.Id} started. Requested HostPort: ${finalHostPortToUseInResponse}.`);

                const internalPortKey = template.defaultPort ? `${template.defaultPort}/tcp` : undefined;
                const portBindingsFromInspect = inspectInfo.NetworkSettings.Ports;
                let actualBoundHostPort: number | null = null;
                if (internalPortKey && portBindingsFromInspect && portBindingsFromInspect[internalPortKey]?.[0]?.HostPort) {
                    actualBoundHostPort = parseInt(portBindingsFromInspect[internalPortKey][0].HostPort);
                }
                if (actualBoundHostPort !== finalHostPortToUseInResponse) {
                    const portMismatchError = `CRITICAL PORT MISMATCH: Requested ${finalHostPortToUseInResponse}, Docker bound to ${actualBoundHostPort}. ASSET_PREFIX will be incorrect.`;
                    console.error(`[API Containers] ${portMismatchError}`);
                    if (dockerContainerInstance) {
                        await dockerContainerInstance.remove({ force: true }).catch(e => console.error(`[API Containers] Cleanup failed for misconfigured container ${containerIdForCleanup}: ${e.message}`));
                    }
                    return next(new Error(portMismatchError));
                }

            } catch (creationError: any) {
                console.error(`[API Containers] Error creating/starting container for project ${projectId}: ${creationError.message}`, creationError);
                if (dockerContainerInstance && containerIdForCleanup) {
                    await dockerContainerInstance.remove({ force: true }).catch(e => console.error(`[API Containers] Cleanup attempt failed for container ${containerIdForCleanup}: ${e.message}`));
                }
                return next(new Error(`Container creation/start failed: ${creationError.message}`));
            }

            if (dockerContainerInstance) {
                await populateWorkspaceAndCreateDbFilesImpl(dockerContainerInstance, projectId, {
                    id: template.id,
                    sourceHostPath: template.sourceHostPath
                });
            } else {
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

        const responseContainerData: SharedContainer = {
            id: dbContainerRecord.id,
            projectId: dbContainerRecord.projectId,
            templateId: dbContainerRecord.templateId,
            status: dbContainerRecord.status,
            hostPort: dbContainerRecord.hostPort,
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
}

export async function startContainerHandler(req: Request, res: Response, next: NextFunction) {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    console.log(`[API Containers] Request received to start container: ${id}`);

    try {
        const dbContainer = await prisma.container.findUnique({ where: { id } });
        if (!dbContainer) {
            console.warn(`[API Containers] Container ${id} not found in database.`);
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
            console.error(`[API Error] Container ${id} found in DB but not in Docker!`);
            await prisma.container.update({ where: { id }, data: { status: 'ERROR' } });
            return res.status(404).json({ message: 'Container not found in Docker engine' });
        }

        const inspectDataBefore = await container.inspect();
        if (inspectDataBefore.State.Running) {
            console.warn(`[API Containers] Container ${id} is running in Docker but DB status was ${dbContainer.status}. Updating DB.`);
            await prisma.container.update({ where: { id }, data: { status: 'RUNNING', startedAt: new Date() } });
            return res.status(200).json({
                message: 'Container is already running (DB updated)', containerId: id, status: 'RUNNING',
                hostPort: dbContainer.hostPort,
            });
        }

        await container.start();
        console.log(`[API Containers] Container started: ${id}`);
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
        await prisma.container.update({
            where: { id },
            data: { status: 'ERROR' }
        }).catch(dbErr => console.error(`[API Error] Failed to update DB status to ERROR for ${id}`, dbErr));
        next(error);
    }
}

export async function stopContainerHandler(req: Request, res: Response, next: NextFunction) {
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
            const dbContainer = await prisma.container.findUnique({ where: { id } });
            if (dbContainer && dbContainer.status !== 'STOPPED' && dbContainer.status !== 'DELETED') {
                await prisma.container.update({ where: { id }, data: { status: 'STOPPED', stoppedAt: new Date() } });
                console.log(`[API Containers] Updated DB status for ${id} to STOPPED as container not found in Docker.`);
            }
            return res.status(dbContainer ? 200 : 404).json({
                message: dbContainer ? 'Container already stopped or removed' : 'Container not found',
                containerId: id,
                status: 'STOPPED'
            });
        }

        const inspectData = await container.inspect();
        if (!inspectData.State.Running) {
            console.log(`[API Containers] Container ${id} is already stopped in Docker.`);
            dbStatusUpdate = 'STOPPED';
        } else {
            await container.stop({ t: timeout });
            console.log(`[API Containers] Container stopped: ${id}`);
            dbStatusUpdate = 'STOPPED';
        }

        await prisma.container.update({
            where: { id },
            data: { status: dbStatusUpdate, stoppedAt: new Date() }
        });
        res.status(200).json({ message: 'Container stopped successfully', containerId: id, status: 'STOPPED' });
    } catch (error: any) {
        console.error(`[API Error] Failed to stop container ${id}:`, error);
        if (error.statusCode === 304) {
            console.log(`[API Containers] Container ${id} reported as already stopped (304). Updating DB.`);
            await prisma.container.update({
                where: { id }, data: { status: 'STOPPED', stoppedAt: new Date() }
            }).catch(dbErr => console.error(`[API Error] Failed to update DB status for ${id} after 304 error`, dbErr));
            return res.status(200).json({ message: 'Container was already stopped', containerId: id, status: 'STOPPED' });
        }
        await prisma.container.update({
            where: { id }, data: { status: 'ERROR' }
        }).catch(dbErr => console.error(`[API Error] Failed to update DB status to ERROR for ${id} after stop failure`, dbErr));
        next(error);
    }
}

export async function deleteContainerHandler(req: Request, res: Response, next: NextFunction) {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    const force = req.query.force === 'true';
    console.log(`[API Containers] Request received to delete container: ${id} (force: ${force})`);

    try {
        const container = await getDockerContainerInstance(id);
        if (container) {
            await container.remove({ force: force });
            console.log(`[API Containers] Container removed from Docker: ${id}`);
        } else {
            console.log(`[API Containers] Container ${id} not found in Docker during delete request.`);
        }

        const updatedDb = await prisma.container.update({
            where: { id },
            data: { status: 'DELETED', hostPort: null, stoppedAt: new Date() }
        }).catch(err => {
            if (err.code === 'P2025') {
                console.log(`[API Containers] DB record for ${id} not found during delete.`);
                return null;
            }
            throw err;
        });

        if (updatedDb) {
            console.log(`[API Containers] Marked container record as DELETED in DB: ${id}`);
            await prisma.project.update({
                where: { id: updatedDb.projectId },
                data: { containerId: null }
            }).catch(err => console.error(`[API Error] Failed to unlink container ${id} from project ${updatedDb.projectId}`, err));
        }
        res.status(200).json({ message: 'Container removed successfully', containerId: id, status: 'DELETED' });
    } catch (error: any) {
        console.error(`[API Error] Failed to remove container ${id}:`, error);
        next(error);
    }
}

export async function getContainerStatusHandler(req: Request, res: Response, next: NextFunction) {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    console.log(`[API Containers] Request received for status of container: ${id}`);

    try {
        let finalStatus: ContainerStatus;
        let dockerState: Docker.ContainerInspectInfo['State'] | undefined = undefined;
        let hostPort: number | null = null;

        const dbContainer = await prisma.container.findUnique({ where: { id } });

        if (!dbContainer || dbContainer.status === 'DELETED') {
            console.log(`[API Containers] Container ${id} not found or marked deleted in DB.`);
            return res.status(404).json({ message: 'Container not found or deleted' });
        }
        hostPort = dbContainer.hostPort;

        if (['RUNNING', 'STOPPED', 'UNKNOWN', 'CREATING', 'ERROR'].includes(dbContainer.status)) {
            const container = await getDockerContainerInstance(id);
            if (!container) {
                console.warn(`Container ${id} found in DB (status: ${dbContainer.status}) but not in Docker. Updating DB status.`);
                finalStatus = 'DELETED';
                await prisma.container.update({ where: { id }, data: { status: finalStatus, stoppedAt: new Date() } });
            } else {
                const inspectData = await container.inspect();
                dockerState = inspectData.State;
                const currentDockerStatus: ContainerStatus = dockerState.Running ? 'RUNNING' :
                    dockerState.Status === 'exited' ? 'STOPPED' :
                        'UNKNOWN';
                finalStatus = currentDockerStatus;
                if (dbContainer.status !== finalStatus) {
                    console.log(`[API Containers] Updating DB status for ${id} from ${dbContainer.status} to ${finalStatus} based on Docker state.`);
                    await prisma.container.update({
                        where: { id },
                        data: {
                            status: finalStatus,
                            ...(finalStatus === 'RUNNING' && !dbContainer.startedAt ? { startedAt: new Date() } : {}),
                            ...(finalStatus === 'STOPPED' && !dbContainer.stoppedAt ? { stoppedAt: new Date() } : {}),
                        }
                    });
                }
            }
        } else {
            finalStatus = dbContainer.status;
        }
        res.status(200).json({
            containerId: id,
            status: finalStatus,
            dockerState: dockerState,
            hostPort: hostPort
        });
    } catch (error: any) {
        console.error(`[API Error] Failed to get status for container ${id}:`, error);
        next(error);
    }
}

export async function getPreviewDetailsHandler(req: Request, res: Response, next: NextFunction) {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }
    console.log(`[API Containers] Request received for preview details of container: ${id}`);

    try {
        const dbContainer = await prisma.container.findUnique({
            where: { id },
            select: { status: true, hostPort: true, internalPort: true, }
        });

        if (!dbContainer) {
            return res.status(404).json({ message: 'Container record not found' });
        }

        if (dbContainer.status !== 'RUNNING' && dbContainer.status !== 'CREATING') {
            console.log(`[API Containers] Preview requested for non-running container ${id} (status: ${dbContainer.status})`);
            return res.status(409).json({
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

        console.log('--- DEBUG START: Preview URL Generation ---');
        console.log('req.protocol:', req.protocol);
        console.log('req.hostname:', req.hostname);
        console.log('req.headers.host:', req.headers.host);
        console.log('req.headers["x-forwarded-proto"]:', req.headers['x-forwarded-proto']);
        console.log('req.headers["x-forwarded-host"]:', req.headers['x-forwarded-host']);
        console.log('req.socket.remoteAddress:', req.socket.remoteAddress);
        console.log('--- DEBUG END: Preview URL Generation ---');

        const domain = req.hostname && req.hostname !== 'localhost'
            ? req.hostname
            : (req.headers.host && typeof req.headers.host === 'string'
                ? req.headers.host.split(':')[0]
                : 'codeyarn.xyz');

        let protocol = req.protocol;
        if (protocol !== 'http' && protocol !== 'https') {
            protocol = 'https';
        }
        if (domain !== 'localhost' && protocol === 'http') {
            protocol = 'https';
        }

        const previewUrl = `${protocol}://${domain}/preview/container/${dbContainer.hostPort}/`;
        console.log(`[API Containers] Generated previewUrl: ${previewUrl}`);

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
}

export async function getFileStatusHandler(req: Request, res: Response, next: NextFunction) {
    const { id } = req.params;
    if (typeof id !== 'string' || !id) {
        return res.status(400).json({ message: 'Invalid container ID provided' });
    }

    try {
        const container = await prisma.container.findUnique({
            where: { id },
            select: { id: true, projectId: true, status: true }
        });

        if (!container) {
            return res.status(404).json({ message: 'Container not found' });
        }

        const dockerContainer = await getDockerContainerInstance(id);
        if (!dockerContainer) {
            return res.status(404).json({ message: 'Docker container not found' });
        }

        const exec = await dockerContainer.exec({
            Cmd: ['stat', '-c', '%Y', '/workspace/index.js'], //   index.js for nodebasic
            AttachStdout: true,
            AttachStderr: true
        });

        const stream = await exec.start({});
        let output = '';
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        stdoutStream.on('data', (chunk) => { output += chunk.toString('utf8'); });
        dockerContainer.modem.demuxStream(stream, stdoutStream, stderrStream);

        await new Promise<void>((resolve) => { stream.on('end', resolve); });

        const modTime = parseInt(output.trim());
        const lastModTime = global.fileWatchMap.get(id) || 0;
        const hasChanged = modTime > lastModTime;

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
        res.status(200).json({ // Non-crashing response on error for this endpoint
            containerId: id,
            filesChanged: false,
            error: error.message,
            lastChecked: new Date().toISOString()
        });
    }
}
// src/routes/containerUtils.ts
import { docker } from '../dockerClient';
import prisma from '@codeyarn/db';
import fs from 'fs-extra';
import path from 'path';
import tar from 'tar-fs';
import { Duplex, PassThrough } from 'stream';
import { Template } from '@codeyarn/shared-types';

// Path to your scan script within the runner image
export const SCAN_SCRIPT_PATH_IN_CONTAINER = '/usr/local/bin/scan-workspace.js';

export async function getDockerContainerInstance(containerIdOrName: string): Promise<Docker.Container | null> {
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
 * Populates a container's workspace with template files
 * and creates corresponding file records in the database.
 */
export async function populateWorkspaceAndCreateDbFilesImpl(
    container: Docker.Container,
    projectId: string,
    template: Pick<Template, 'id'> & { sourceHostPath?: string | null }
): Promise<void> {
    console.log(`[WorkspacePopulation] Starting for project ${projectId}, template ${template.id}`);
    const containerId = container.id;

    if (!template.sourceHostPath) {
        console.warn(`[WorkspacePopulation] Template ${template.id} has no sourceHostPath. Skipping file copy.`);
    } else {
        if (
            !(await fs.pathExists(template.sourceHostPath)) ||
            !(await fs.stat(template.sourceHostPath)).isDirectory()
        ) {
            console.error(`[WorkspacePopulation] Template source path invalid: ${template.sourceHostPath}`);
            throw new Error(`Template source path invalid or not a directory: ${template.sourceHostPath}`);
        }
        try {
            console.log(`[WorkspacePopulation] Creating tar from: ${template.sourceHostPath}`);
            const tarStream = tar.pack(template.sourceHostPath);
            await container.putArchive(tarStream, { path: '/workspace/' });
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
 * Run a scan script inside a Docker container, parse the returned JSON,
 * and store/update file entries in the database.
 */
export async function createFileRecordsFromContainer(
    container: Docker.Container,
    projectId: string
): Promise<void> {
    console.log(`[DB Files] Starting workspace scan for container ${container.id}, project ${projectId}`);
    let fileListJson = '[]';
    try {
        try {
            const testExec = await container.exec({
                Cmd: ['test', '-f', SCAN_SCRIPT_PATH_IN_CONTAINER],
                AttachStdout: false,
                AttachStderr: false
            });
            await testExec.start({});
            console.log(`[DB Files] Scan script found at ${SCAN_SCRIPT_PATH_IN_CONTAINER}.`);
        } catch (scriptCheckError) {
            console.warn(`[DB Files] Scan script not found at ${SCAN_SCRIPT_PATH_IN_CONTAINER}. Using default workspace setup.`);
            throw new Error('Scan script not found');
        }

        const exec = await container.exec({
            Cmd: ['node', SCAN_SCRIPT_PATH_IN_CONTAINER],
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: '/workspace'
        });
        console.log(`[DB Files] Executing scan script in container ${container.id}.`);

        const stream: Duplex = await exec.start({});

        let stdout = '';
        let stderr = '';
        console.log(`[DB Files] Capturing scan script output.`);
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        stdoutStream.on('data', chunk => stdout += chunk.toString('utf8'));
        stderrStream.on('data', chunk => stderr += chunk.toString('utf8'));
        container.modem.demuxStream(stream, stdoutStream, stderrStream);
        
        await new Promise<void>((resolve, reject) => {
            stream.on('end', () => {
                console.log(`[DB Files] Captured scan script output (on end): ${stdout.trim()}`);
                console.log(`[DB Files] Captured scan script error (on end): ${stderr.trim()}`);
                resolve();
            });
            stream.on('error', reject);
        });

        const inspectData = await exec.inspect();
        console.log(`[DB Files] Scan script in container ${container.id} exited with code ${inspectData.ExitCode}.`);

        if (inspectData.ExitCode !== 0) {
            console.error(`[DB Files] Scan script in container ${container.id} exited with code ${inspectData.ExitCode}. Stderr: ${stderr.trim()}`);
        } else {
            fileListJson = stdout.trim();
            console.log(`[DB Files] Scan script in container ${container.id} produced stdout output: ${stdout.trim()}`);
            if (stderr.trim()) {
                console.warn(`[DB Files] Scan script in container ${container.id} produced stderr output: ${stderr.trim()}`);
            }
        }
    } catch (error) {
        console.error(`[DB Files] Error executing scan script in container ${container.id}:`, error);
    }

    let rawFileEntries: {
        name: string;
        path: string;
        isDirectory: boolean;
        content?: string
    }[] = [];
    try {
        rawFileEntries = JSON.parse(fileListJson);
    } catch (e) {
        console.error('[DB Files] Failed to parse file structure JSON from scan script output:', e, 'Raw JSON received:', `"${fileListJson}"`);
        if (fileListJson.trim() === "" || fileListJson.trim() === "[]") {
            console.log("[DB Files] Scan script returned empty or no valid JSON. Ensuring /workspace root exists.");
        } else {
            throw new Error("Failed to parse workspace scan result.");
        }
    }

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

    rawFileEntries.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    const createdNodesMap = new Map<string, string>();

    for (const entry of rawFileEntries) {
        let normalizedEntryPath = path.posix.normalize(entry.path);
        if (!normalizedEntryPath.startsWith('/')) normalizedEntryPath = '/' + normalizedEntryPath;
        if (normalizedEntryPath.endsWith('/') && normalizedEntryPath !== '/') normalizedEntryPath = normalizedEntryPath.slice(0, -1);
        if (normalizedEntryPath === "") normalizedEntryPath = "/";

        const parentDirSystemPath = path.posix.dirname(normalizedEntryPath);
        let parentId: string | null = null;

        if (normalizedEntryPath === '/workspace') {
            parentId = null;
        } else if (parentDirSystemPath === '/' || parentDirSystemPath === '/workspace') {
            parentId = createdNodesMap.get('/workspace') || null;
            if (!parentId) {
                const rootNode = await prisma.file.findFirst({ where: { projectId, path: '/workspace' } });
                if (rootNode) parentId = rootNode.id;
                else console.error(`[DB Files] Critical: /workspace root node not found for parent lookup of ${normalizedEntryPath}`);
            }
        } else {
            parentId = createdNodesMap.get(parentDirSystemPath) || null;
        }

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
                    content: entry.content || null,
                }
            });
            createdNodesMap.set(normalizedEntryPath, fileRecord.id);
            console.log(`[DB Files] Created DB record for ${normalizedEntryPath} (ID: ${fileRecord.id}, ParentID: ${parentId})`);
        } catch (dbError: any) {
            console.error(`[DB Files] Failed to create DB record for ${normalizedEntryPath} in project ${projectId}. ParentPath: ${parentDirSystemPath}, Resolved ParentID: ${parentId}. Error:`, dbError.message);
        }
    }
    console.log(`[DB Files] Created/verified ${createdNodesMap.size} DB file records for project ${projectId}`);
}
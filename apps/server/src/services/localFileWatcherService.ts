// src/services/localFileWatcherService.ts
// ignore this file
import fs from 'fs';
import path from 'node:path';
import prisma from '@codeyarn/db';
import { Server as SocketIOServer } from 'socket.io';

const containerFileWatchers = new Map<string, fs.FSWatcher>();
const fileModificationTimes = new Map<string, Map<string, number>>();

export async function setupFileWatcher(containerId: string, io: SocketIOServer) {
    try {
        if (containerFileWatchers.has(containerId)) {
            console.log(`[FileWatcher] Watcher already exists for container ${containerId}`);
            return;
        }

        const container = await prisma.container.findUnique({
            where: { id: containerId },
            select: { projectId: true, templateId: true }
        });

        if (!container) {
            console.error(`[FileWatcher] Container ${containerId} not found in database`);
            return;
        }

        // This logic is specific to 'nodebasic' template and local path.
        // Adapt if your file watching needs are different (e.g., watching Docker volumes).
        if (container.templateId === 'nodebasic') { // Example condition
            const templateDir = path.resolve(__dirname, '../../../templates/nodebasic'); // Adjust path as necessary
            const indexJsPath = path.join(templateDir, 'index.js');

            if (!fs.existsSync(templateDir)) {
                console.warn(`[FileWatcher] Template directory ${templateDir} does not exist.
                     Cannot set up watcher.`);
                return;
            }
             if (!fs.existsSync(indexJsPath)) {
                console.warn(`[FileWatcher] index.js not found at ${indexJsPath}. 
                    Cannot set up watcher effectively for this file.`);
                // Decide if you want to watch the directory anyway or return
            }


            console.log(`[FileWatcher] Setting up watcher for ${indexJsPath} in dir ${templateDir}`);

            if (!fileModificationTimes.has(containerId)) {
                fileModificationTimes.set(containerId, new Map());
            }
            try {
                if (fs.existsSync(indexJsPath)) {
                    const stats = fs.statSync(indexJsPath);
                    fileModificationTimes.get(containerId)?.set(indexJsPath, stats.mtimeMs);
                }
            } catch (err) {
                console.error(`[FileWatcher] Error getting initial file stats for ${indexJsPath}: ${err}`);
            }

            const watcher = fs.watch(templateDir, {persistent: false}, (eventType, filename) => {
                if (filename === 'index.js') {
                    try {
                        if (!fs.existsSync(indexJsPath)) {
                             console.log(`[FileWatcher] ${indexJsPath} was deleted or renamed.`);
                             // Potentially emit a delete event or handle appropriately
                             return;
                        }
                        const stats = fs.statSync(indexJsPath);
                        const lastMtime = fileModificationTimes.get(containerId)?.get(indexJsPath) || 0;

                        if (stats.mtimeMs > lastMtime) {
                            console.log(`[FileWatcher] Detected change in ${filename} for container ${containerId}`);
                            fileModificationTimes.get(containerId)?.set(indexJsPath, stats.mtimeMs);

                            io.to(containerId).emit('file-changed', {
                                containerId,
                                path: `/workspace/${filename}`, // Assuming this is the logical path in container
                                type: 'file',
                                event: eventType
                            });
                        }
                    } catch (err) {
                        console.error(`[FileWatcher] Error checking file stats during watch event for ${indexJsPath}: ${err}`);
                    }
                }
            });

            watcher.on('error', (error) => {
                console.error(`[FileWatcher] Watcher error for container ${containerId} on ${templateDir}:`, error);
                containerFileWatchers.delete(containerId); // Remove faulty watcher
                // Optionally, try to re-establish the watcher or notify admins
            });


            containerFileWatchers.set(containerId, watcher);
            console.log(`[FileWatcher] Watcher set up for container ${containerId} on directory ${templateDir}`);
        } else {
            console.log(`[FileWatcher] No specific local file watcher setup for templateId: ${container.templateId}`);
        }

    } catch (error) {
        console.error(`[FileWatcher] Error setting up watcher for container ${containerId}:`, error);
    }
}
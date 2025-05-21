// src/socket/connectionHandler.ts
import { Socket, Server as SocketIOServer } from 'socket.io';
import { containerRoomSockets, activePtySessions, ptyCleanupTimers } from './socketState';
import { startPtySessionAndAttachSocket } from './ptyManager';
import { handleGetInitialFileSystem } from './fileSystemHandler';
import { setupFileWatcher } from '../services/localFileWatcherService'; // Adjusted path
import prisma from '@codeyarn/db'; // Ensure prisma is correctly set up

function cleanupSocketResources(socketId: string, containerId: string | null) {
    if (containerId) {
        containerRoomSockets.get(containerId)?.delete(socketId);
        if (containerRoomSockets.get(containerId)?.size === 0) {
            containerRoomSockets.delete(containerId);
        }

        const ptySession = activePtySessions.get(containerId);
        if (ptySession) {
            ptySession.sockets.delete(socketId);
            console.log(`[PTY] Socket ${socketId} removed from PTY on ${containerId}. Sockets remaining: ${ptySession.sockets.size}`);
        }
    }
}


export function initializeConnectionHandlers(io: SocketIOServer) {
    io.on('connection', (socket: Socket) => {
        console.log(`[Socket.IO] Client connected: ${socket.id}`);
        let associatedContainerId: string | null = null;

        socket.on('register-container', (containerId: string) => {
            if (typeof containerId !== 'string' || !containerId) return;
            console.log(`[Socket.IO] Registering socket ${socket.id} to container room: ${containerId}`);
            associatedContainerId = containerId;

            if (!containerRoomSockets.has(containerId)) {
                containerRoomSockets.set(containerId, new Set());
            }
            containerRoomSockets.get(containerId)?.add(socket.id);
            socket.join(containerId);

            if (ptyCleanupTimers.has(containerId)) {
                clearTimeout(ptyCleanupTimers.get(containerId)!);
                ptyCleanupTimers.delete(containerId);
                console.log(`[PTY] Cleared pending cleanup timer for container ${containerId} due to new registration.`);
            }

            let ptySession = activePtySessions.get(containerId);
            if (ptySession) {
                ptySession.sockets.add(socket.id);
                console.log(`[PTY] Socket ${socket.id} re-attached to existing PTY for container ${containerId}. Total sockets: ${ptySession.sockets.size}`);
                socket.emit('registered', { containerId });
                if (ptySession.scrollback && ptySession.scrollback.length > 0) {
                    socket.emit('terminal-output', { output: ptySession.scrollback.join('') });
                }
                socket.emit('terminal-ready', { containerId });
            } else {
                console.log(`[PTY] No existing PTY for ${containerId}. Starting new session for socket ${socket.id}...`);
                socket.emit('registered', { containerId });
                startPtySessionAndAttachSocket(socket, containerId);
            }
           // setupFileWatcher(containerId, io);  
        });

        socket.on('terminal-input', (data: { input: string }) => {
            if (associatedContainerId) {
                const ptySession = activePtySessions.get(associatedContainerId);
                if (ptySession?.stream && data?.input) {
                    ptySession.stream.write(data.input);
                } else {
                    console.warn(`[Socket.IO] Received terminal-input for ${associatedContainerId} from ${socket.id} but no active PTY stream found.`);
                }
            }
        });

        socket.on('terminal-resize', async (data: { rows: number, cols: number }) => {
            if (associatedContainerId) {
                const ptySession = activePtySessions.get(associatedContainerId);
                if (ptySession?.exec && data?.rows && data?.cols) {
                    try {
                        await ptySession.exec.resize({ h: data.rows, w: data.cols });
                    } catch (error) {
                        console.error(`[Socket.IO] Error resizing PTY for ${associatedContainerId} (socket ${socket.id}):`, error);
                    }
                }
            }
        });

        socket.on('get-initial-fs', (containerId: string) => {
            handleGetInitialFileSystem(socket, containerId);
        });

        socket.on('disconnect', (reason: string) => {
            console.log(`[Socket.IO] Client disconnected: ${socket.id}. Reason: ${reason}`);
            const disconnectingContainerId = associatedContainerId;
            cleanupSocketResources(socket.id, disconnectingContainerId);

            if (disconnectingContainerId) {
                const ptySession = activePtySessions.get(disconnectingContainerId);
                if (ptySession && ptySession.sockets.size === 0) {
                    if (!ptyCleanupTimers.has(disconnectingContainerId)) {
                        console.log(`[PTY] No sockets remaining for PTY on container ${disconnectingContainerId}. Scheduling cleanup in 15s.`);
                        const timer = setTimeout(() => {
                            const sessionToKill = activePtySessions.get(disconnectingContainerId);
                            if (sessionToKill && sessionToKill.sockets.size === 0) {
                                console.log(`[PTY] Killing PTY for container ${disconnectingContainerId} after 15s timeout.`);
                                try {
                                    sessionToKill.stream.write('\x03'); // SIGINT
                                    sessionToKill.stream.end();
                                } catch (e) {
                                    console.error(`[PTY] Error sending SIGINT or ending stream for ${disconnectingContainerId}:`, e);
                                }
                                activePtySessions.delete(disconnectingContainerId);
                            } else if (sessionToKill) {
                                console.log(`[PTY] Cleanup for ${disconnectingContainerId} aborted, new connections detected.`);
                            }
                            ptyCleanupTimers.delete(disconnectingContainerId);
                        }, 15000);
                        ptyCleanupTimers.set(disconnectingContainerId, timer);
                    }
                } else if (ptySession) {
                    console.log(`[PTY] Socket ${socket.id} disconnected from ${disconnectingContainerId}. Sockets remaining: ${ptySession.sockets.size}`);
                }
            }
        });

        socket.on('connect_error', (err) => {
            console.error(`[Socket.IO] Connection error for ${socket.id}: ${err.message}`);
            cleanupSocketResources(socket.id, associatedContainerId);
        });
    });
}
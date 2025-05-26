// src/socket/connectionHandler.ts
import { Socket, Server as SocketIOServer } from 'socket.io';
import { containerRoomSockets, activePtySessions, ptyCleanupTimers } from './socketState'; // Import shared socket state
import { startPtySessionAndAttachSocket } from './ptyManager'; // Import PTY session management
import { handleGetInitialFileSystem } from './fileSystemHandler'; // Import handler for initial file system requests
// import { setupFileWatcher } from '../services/localFileWatcherService'; // Assuming this might be re-enabled later

/**
 * Cleans up resources associated with a disconnected or errored socket.
 * @param socketId - The ID of the socket to clean up.
 * @param containerId - The ID of the container the socket was associated with, if any.
 */
function cleanupSocketResources(socketId: string, containerId: string | null) {
    // If the socket was associated with a container room.
    if (containerId) {
        // Remove the socket from the set of sockets in the container's general update room.
        containerRoomSockets.get(containerId)?.delete(socketId);
        // If the room becomes empty, delete the room entry from the map.
        if (containerRoomSockets.get(containerId)?.size === 0) {
            containerRoomSockets.delete(containerId);
        }

        // Get the PTY session associated with the container.
        const ptySession = activePtySessions.get(containerId);
        if (ptySession) {
            // Remove the socket from the set of sockets connected to this PTY session.
            ptySession.sockets.delete(socketId);
            console.log(`[PTY] Socket ${socketId} removed from PTY on ${containerId}. Sockets remaining: ${ptySession.sockets.size}`);
        }
    }
}

/**
 * Initializes all Socket.IO event handlers for new client connections.
 * @param io - The Socket.IO server instance.
 */
export function initializeConnectionHandlers(io: SocketIOServer) {
    // Listen for new client connections.
    io.on('connection', (socket: Socket) => {
        console.log(`[Socket.IO] Client connected: ${socket.id}`);
        // Stores the container ID this specific socket instance is primarily associated with.
        let associatedContainerId: string | null = null;

        // Handle client request to register for updates and terminal for a specific container.
        socket.on('register-container', (containerId: string) => {
            // Validate the received containerId.
            if (typeof containerId !== 'string' || !containerId) {
                console.warn(`[Socket.IO] Invalid containerId received from ${socket.id}:`, containerId);
                return;
            }
            console.log(`[Socket.IO] Registering socket ${socket.id} to container room: ${containerId}`);
            associatedContainerId = containerId; // Associate this socket with the container.

            // Add socket to the general room for this container (for broadcasts).
            if (!containerRoomSockets.has(containerId)) {
                containerRoomSockets.set(containerId, new Set());
            }
            containerRoomSockets.get(containerId)?.add(socket.id);
            socket.join(containerId); // Socket.IO specific room joining.

            // If a PTY cleanup timer was pending for this container, clear it as a client has re-registered.
            if (ptyCleanupTimers.has(containerId)) {
                clearTimeout(ptyCleanupTimers.get(containerId)!);
                ptyCleanupTimers.delete(containerId);
                console.log(`[PTY] Cleared pending cleanup timer for container ${containerId} due to new registration.`);
            }

            // Manage PTY session: attach to existing or start a new one.
            let ptySession = activePtySessions.get(containerId);
            if (ptySession) {
                // If a PTY session already exists, add this socket to it.
                ptySession.sockets.add(socket.id);
                console.log(`[PTY] Socket ${socket.id} re-attached to existing PTY for container ${containerId}. Total sockets: ${ptySession.sockets.size}`);
                socket.emit('registered', { containerId }); // Confirm registration to client.
                // Send any buffered scrollback history to the re-attaching client.
                if (ptySession.scrollback && ptySession.scrollback.length > 0) {
                    socket.emit('terminal-output', { output: ptySession.scrollback.join('') });
                }
                socket.emit('terminal-ready', { containerId }); // Notify client terminal is ready.
            } else {
                // If no PTY session exists, start a new one for this container.
                console.log(`[PTY] No existing PTY for ${containerId}. Starting new session for socket ${socket.id}...`);
                socket.emit('registered', { containerId }); // Confirm registration before starting PTY.
                startPtySessionAndAttachSocket(socket, containerId); // Function to create and manage the PTY.
            }
            // Example: setupFileWatcher(containerId, io); // If local file watching per container is needed.
        });

        // Handle terminal input from the client.
        socket.on('terminal-input', (data: { input: string }) => {
            // Ensure the socket is associated with a container.
            if (associatedContainerId) {
                const ptySession = activePtySessions.get(associatedContainerId);
                // If an active PTY stream exists and input data is present, write to PTY.
                if (ptySession?.stream && data?.input) {
                    ptySession.stream.write(data.input);
                } else {
                    console.warn(`[Socket.IO] Received terminal-input for ${associatedContainerId} from ${socket.id} but no active PTY stream found or no input provided.`);
                }
            }
        });

        // Handle terminal resize events from the client.
        socket.on('terminal-resize', async (data: { rows: number, cols: number }) => {
            // Ensure the socket is associated with a container.
            if (associatedContainerId) {
                const ptySession = activePtySessions.get(associatedContainerId);
                // If an active PTY exec instance exists and dimensions are provided, resize PTY.
                if (ptySession?.exec && data?.rows && data?.cols) {
                    try {
                        await ptySession.exec.resize({ h: data.rows, w: data.cols });
                    } catch (error) {
                        console.error(`[Socket.IO] Error resizing PTY for ${associatedContainerId} (socket ${socket.id}):`, error);
                    }
                }
            }
        });

        // Handle client request to get the initial file system structure.
        socket.on('get-initial-fs', (containerId: string) => {
            // Delegate to the file system handler.
            handleGetInitialFileSystem(socket, containerId);
        });

        // Handle client disconnection.
        socket.on('disconnect', (reason: string) => {
            console.log(`[Socket.IO] Client disconnected: ${socket.id}. Reason: ${reason}`);
            const disconnectingContainerId = associatedContainerId; // Cache ID before cleanup might nullify it.
            // Clean up resources associated with this socket.
            cleanupSocketResources(socket.id, disconnectingContainerId);

            // If the socket was associated with a container, manage PTY cleanup.
            if (disconnectingContainerId) {
                const ptySession = activePtySessions.get(disconnectingContainerId);
                // If a PTY session exists and no more sockets are connected to it, schedule its cleanup.
                if (ptySession && ptySession.sockets.size === 0) {
                    if (!ptyCleanupTimers.has(disconnectingContainerId)) { // Avoid setting multiple timers.
                        console.log(`[PTY] No sockets remaining for PTY on container ${disconnectingContainerId}. Scheduling cleanup in 15s.`);
                        const timer = setTimeout(() => {
                            // Re-check session and socket count before killing, in case a client reconnected.
                            const sessionToKill = activePtySessions.get(disconnectingContainerId);
                            if (sessionToKill && sessionToKill.sockets.size === 0) {
                                console.log(`[PTY] Killing PTY for container ${disconnectingContainerId} after 15s timeout.`);
                                try {
                                    sessionToKill.stream.write('\x03'); // Send SIGINT (Ctrl+C) to try graceful shutdown.
                                    sessionToKill.stream.end();       // Close the stream.
                                } catch (e) {
                                    console.error(`[PTY] Error sending SIGINT or ending stream for ${disconnectingContainerId}:`, e);
                                }
                                activePtySessions.delete(disconnectingContainerId); // Remove session from active map.
                            } else if (sessionToKill) {
                                console.log(`[PTY] Cleanup for ${disconnectingContainerId} aborted, new connections detected.`);
                            }
                            ptyCleanupTimers.delete(disconnectingContainerId); // Remove the timer from the map.
                        }, 15000); // 15-second timeout before PTY cleanup.
                        ptyCleanupTimers.set(disconnectingContainerId, timer); // Store the timer.
                    }
                } else if (ptySession) {
                    // Log if other sockets are still connected to this PTY.
                    console.log(`[PTY] Socket ${socket.id} disconnected from ${disconnectingContainerId}. Sockets remaining: ${ptySession.sockets.size}`);
                }
            }
        });

        // Handle connection errors for this specific socket.
        socket.on('connect_error', (err) => {
            console.error(`[Socket.IO] Connection error for ${socket.id}: ${err.message}`);
            // Clean up resources as this connection failed.
            cleanupSocketResources(socket.id, associatedContainerId);
        });
    });
}
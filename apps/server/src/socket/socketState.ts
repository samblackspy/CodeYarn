// src/socket/socketState.ts
import { Duplex } from 'stream';
import Docker from 'dockerode';

// Tracks which client sockets are interested in general updates for a specific container ID.
export const containerRoomSockets = new Map<string, Set<string>>();

// Tracks which client sockets are connected to a specific PTY session for a container.
export const activePtySessions = new Map<string, {
    stream: Duplex,
    exec: Docker.Exec,
    sockets: Set<string>, // set of socket.ids(client) connected to this PTY 
    // broadcast terminal output to all attached clients (e.g., multiple tabs)
    scrollback: string[]  // Buffer for recent terminal output
}>();

// Tracks cleanup timers for PTY sessions to ensure proper cleanup when clients disconnect.
export const ptyCleanupTimers = new Map<string, NodeJS.Timeout>();
// src/socket/ptyManager.ts
import { Socket } from 'socket.io';
import Docker from 'dockerode';
import { Duplex } from 'stream';
import { docker } from '../dockerClient'; // Assuming dockerClient.ts is in src/
import { activePtySessions, ptyCleanupTimers } from './socketState';
import { MAX_SCROLLBACK_LINES } from '../config';
import { io } from './ioServer'; // For emitting updates globally or to rooms

export async function startPtySessionAndAttachSocket(initialSocket: Socket, containerId: string) {
    console.log(`[PTY] Attempting to start PTY session for container ${containerId} by socket ${initialSocket.id}`);
    try {
        const container = docker.getContainer(containerId);
        const inspectData = await container.inspect();

        if (!inspectData.State.Running) {
            console.log(`[PTY] Container ${containerId} is not running.`);
            initialSocket.emit('terminal-error', { 
                message: `Container ${containerId} is not running.` 
            });
            return;
        }

        const execOptions: Docker.ExecCreateOptions = {
            AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
            Cmd: ['/bin/ash'], WorkingDir: '/workspace', User: 'coder'
        };

        const exec = await container.exec(execOptions);
        const stream = await exec.start({ hijack: true, stdin: true });

        console.log(`[PTY] Stream started successfully for ${containerId}. Initial socket: ${initialSocket.id}`);
        activePtySessions.set(containerId, {
            stream,
            exec,
            sockets: new Set([initialSocket.id]),
            scrollback: [] // Initialize scrollback buffer
        });

        stream.on('data', (chunk) => {
            const output = chunk.toString();
            const session = activePtySessions.get(containerId);
            if (session) {
                session.scrollback.push(output);
                if (session.scrollback.length > MAX_SCROLLBACK_LINES) {
                    session.scrollback.splice(0, session.scrollback.length - MAX_SCROLLBACK_LINES);
                }
            }
            io.to(containerId).emit('terminal-output', { output });
        });

        stream.on('end', () => {
            console.log(`[PTY] Stream ended for container ${containerId}`);
            io.to(containerId).emit('terminal-error', { 
                message: 'Terminal session ended.' 
            });
            activePtySessions.delete(containerId);
            if (ptyCleanupTimers.has(containerId)) {
                clearTimeout(ptyCleanupTimers.get(containerId)!);
                ptyCleanupTimers.delete(containerId);
            }
        });

        stream.on('error', (error) => {
            console.error(`[PTY] Stream error for container ${containerId}:`, error);
            io.to(containerId).emit('terminal-error', { 
                message: `Terminal stream error: ${error.message}` 
            });
            activePtySessions.delete(containerId);
            if (ptyCleanupTimers.has(containerId)) {
                clearTimeout(ptyCleanupTimers.get(containerId)!);
                ptyCleanupTimers.delete(containerId);
            }
        });

        initialSocket.emit('terminal-ready', { containerId });
        console.log(`[PTY] Emitted 'terminal-ready' to initial socket ${initialSocket.id} for ${containerId}`);

    } catch (error: any) {
        console.error(`[PTY] Failed to start PTY session for container ${containerId}:`, error);
        initialSocket.emit('terminal-error', { 
            message: `Failed to start terminal: ${error.message || 'Unknown error'}` 
        });
    }
}
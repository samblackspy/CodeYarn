// codeyarn/apps/server/src/index.ts
import express, { Express, Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import cors from 'cors';
import Docker from 'dockerode';
import { User, ContainerStatus, FileSystemNode } from '@codeyarn/shared-types';
import containerRoutes from './routes/containerRoutes';
import fileRoutes from './routes/fileRoutes';
import projectRoutes from './routes/projectRoutes';
import templateRoutes from './routes/templateRoutes';
import prisma from '@codeyarn/db';
import { Duplex } from 'stream';
import path from 'node:path';
import fs from 'fs';
// Import the helper function and necessary types from the utils library
import { buildTreeFromFlatList, PrismaFileNode, FileStructureNode } from './lib/utils';


// --- Configuration ---
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
console.log(`[Server] Starting on port ${PORT} with CORS origin: ${CORS_ORIGIN}`);

// --- Application Setup ---
const app: Express = express();
app.set('trust proxy', 1); // Trust the proxy for secure cookies

const httpServer = http.createServer(app);

// --- Dockerode Client Setup ---
const docker = new Docker();

// --- Middleware ---
app.use(cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
}));
// Use raw text parser specifically for the file content update route first
app.use('/api/files/:fileId/content', express.text({ type: '*/*' }));
// Use JSON parser for other routes
app.use(express.json());

// Simple request logger
app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// --- API Routes ---
app.get('/api/health', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use('/api/containers', containerRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/projects', projectRoutes); // Mount project router
app.use('/api/templates', templateRoutes); // Mount template router

// Example Docker test route (optional)
app.get('/api/docker/containers', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const containers = await docker.listContainers({ all: true });
        const simplifiedContainers = containers.map(c => ({ id: c.Id, names: c.Names, image: c.Image, state: c.State, status: c.Status }));
        res.status(200).json(simplifiedContainers);
     } catch (error) { next(error); }
});

// --- WebSocket Setup ---
const io = new SocketIOServer(httpServer, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST'],
        credentials: true
    },
    path: '/socket.io/',
    pingTimeout: 120000,     // Increased timeout
    pingInterval: 30000,     // Adjusted interval
    transports: ['websocket', 'polling'],
    allowEIO3: true,         // Allow Engine.IO v3 compatibility
    cookie: {
        name: 'io',
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production'
    },
    connectTimeout: 45000    // Longer connect timeout
});

console.log(`[Socket.IO] Initialized with CORS origin: ${CORS_ORIGIN}`);


// Map containerId to a general room for other non-PTY specific socket communications
const containerRoomSockets = new Map<string, Set<string>>();
// Map containerId to its active PTY session and connected socket IDs
const activePtySessions = new Map<string, { 
    stream: NodeJS.ReadWriteStream, 
    exec: Docker.Exec, 
    sockets: Set<string>,  // Set of socket.ids connected to this PTY
    scrollback: string[]   // Buffer for recent terminal output
}>();
// Track PTY cleanup timers by containerId
const ptyCleanupTimers = new Map<string, NodeJS.Timeout>();

const MAX_SCROLLBACK_LINES = 200; // Define max lines for scrollback buffer

// Track file watchers for each container
const containerFileWatchers = new Map<string, fs.FSWatcher>();

// Track file modification times to detect changes
const fileModificationTimes = new Map<string, Map<string, number>>();

io.on('connection', (socket: Socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);
    let associatedContainerId: string | null = null;

    socket.on('register-container', (containerId: string) => {
        if (typeof containerId !== 'string' || !containerId) return;
        console.log(`[Socket.IO] Registering socket ${socket.id} to container room: ${containerId}`);
        associatedContainerId = containerId;

        // Manage general room membership
        if (!containerRoomSockets.has(containerId)) {
            containerRoomSockets.set(containerId, new Set());
        }
        containerRoomSockets.get(containerId)?.add(socket.id);
        socket.join(containerId); // Socket joins the room for broadcasts

        // --- PTY Session Management ---
        if (ptyCleanupTimers.has(containerId)) {
            clearTimeout(ptyCleanupTimers.get(containerId)!);
            ptyCleanupTimers.delete(containerId);
            console.log(`[PTY] Cleared pending cleanup timer for container ${containerId} due to new registration.`);
        }

        let ptySession = activePtySessions.get(containerId);
        if (ptySession) {
            // PTY session already exists, add this socket to it
            ptySession.sockets.add(socket.id);
            console.log(`[PTY] Socket ${socket.id} re-attached to existing PTY for container ${containerId}. Total sockets: ${ptySession.sockets.size}`);
            socket.emit('registered', { containerId });

            // Send scrollback buffer to the re-attaching client
            if (ptySession.scrollback && ptySession.scrollback.length > 0) {
                socket.emit('terminal-output', { output: ptySession.scrollback.join('') });
            }
            socket.emit('terminal-ready', { containerId }); // Notify client terminal is ready
            // Optionally, you might want to send some scrollback or a screen clear command here
        } else {
            // No PTY session exists, start a new one
            console.log(`[PTY] No existing PTY for ${containerId}. Starting new session for socket ${socket.id}...`);
            socket.emit('registered', { containerId }); // Emit registered before starting session
            startPtySessionAndAttachSocket(socket, containerId);
        }
        
        // Set up file watcher for this container if it doesn't exist
        setupFileWatcher(containerId);
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

    socket.on('get-initial-fs', async (containerId: string) => {
         console.log(`[Socket.IO] Received get-initial-fs for ${containerId} from ${socket.id}`);
         try {
             const containerRecord = await prisma.container.findUnique({ where: { id: containerId }, select: { projectId: true }});
             if (!containerRecord) throw new Error(`Container record not found: ${containerId}`);
             const projectId = containerRecord.projectId;

             // Fetch nodes with Date objects (PrismaFileNode structure)
             const fileNodesFromDb = await prisma.file.findMany({
                 where: { projectId: projectId },
                 select: {
                    id: true, name: true, path: true, projectId: true, parentId: true,
                    isDirectory: true, createdAt: true, updatedAt: true,
                 },
                 orderBy: { path: 'asc' }
                });

             // Use the imported helper function - it expects PrismaFileNode[] and returns FileStructureNode | null
             const fileTree = buildTreeFromFlatList(fileNodesFromDb as PrismaFileNode[], projectId); // Pass projectId

             console.log(`[Socket.IO] Sending initial-fs for project ${projectId} to ${socket.id}`);
             socket.emit('initial-fs', {
                 containerId: containerId,
                 projectId: projectId,
                 fileStructure: fileTree // Send the nested tree with string dates
                });
         } catch (error: any) {
             console.error(`[Socket.IO Error] Failed to get initial FS for container ${containerId}:`, error);
             socket.emit('fs-error', { containerId: containerId, error: 'Failed to load file structure' });
         }
     });

    socket.on('disconnect', (reason: string) => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id}. Reason: ${reason}`);
        const disconnectingContainerId = associatedContainerId; // Capture before cleanup
        cleanupSocketResources(socket.id, disconnectingContainerId);

        // --- PTY Cleanup Timer Logic ---
        if (disconnectingContainerId) {
            const ptySession = activePtySessions.get(disconnectingContainerId);
            // If PTY session exists and no sockets are connected to it, schedule cleanup
            if (ptySession && ptySession.sockets.size === 0) {
                if (!ptyCleanupTimers.has(disconnectingContainerId)) {
                    console.log(`[PTY] No sockets remaining for PTY on container ${disconnectingContainerId}. Scheduling cleanup in 15s.`);
                    const timer = setTimeout(() => {
                        const sessionToKill = activePtySessions.get(disconnectingContainerId);
                        if (sessionToKill && sessionToKill.sockets.size === 0) { // Double check no new connections
                            console.log(`[PTY] Killing PTY for container ${disconnectingContainerId} after 15s timeout.`);
                            try {
                                sessionToKill.stream.write('\x03'); // Send SIGINT (Ctrl+C) to attempt graceful shutdown
                                sessionToKill.stream.end();        // Then close the stream
                                // Optionally, try to force close the exec if stream.end() is not enough
                                // sessionToKill.exec?.resize({ h: 0, w: 0 }); 
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

// --- Helper Functions (Terminal & Cleanup) ---
async function startPtySessionAndAttachSocket(initialSocket: Socket, containerId: string) {
    console.log(`[PTY] Attempting to start PTY session for container ${containerId} by socket ${initialSocket.id}`);
    try {
        const container = docker.getContainer(containerId);
        const inspectData = await container.inspect();
        
        if (!inspectData.State.Running) {
             console.log(`[PTY] Container ${containerId} is not running.`);
             initialSocket.emit('terminal-error', { message: `Container ${containerId} is not running.` }); return;
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

        // Handle PTY output - broadcast to all sockets in the container's room
        stream.on('data', (chunk) => {
            const output = chunk.toString();
            // Add to scrollback buffer
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
            io.to(containerId).emit('terminal-error', { message: 'Terminal session ended.' });
            activePtySessions.delete(containerId);
            // Also clear any cleanup timer if the stream ends unexpectedly
            if (ptyCleanupTimers.has(containerId)) {
                clearTimeout(ptyCleanupTimers.get(containerId)!);
                ptyCleanupTimers.delete(containerId);
            }
        });

        stream.on('error', (error) => {
            console.error(`[PTY] Stream error for container ${containerId}:`, error);
            io.to(containerId).emit('terminal-error', { message: `Terminal stream error: ${error.message}` });
            activePtySessions.delete(containerId);
            if (ptyCleanupTimers.has(containerId)) {
                clearTimeout(ptyCleanupTimers.get(containerId)!);
                ptyCleanupTimers.delete(containerId);
            }
        });

        // Notify the initial client that the terminal is ready
        initialSocket.emit('terminal-ready', { containerId });
        console.log(`[PTY] Emitted 'terminal-ready' to initial socket ${initialSocket.id} for ${containerId}`);

    } catch (error: any) {
        console.error(`[PTY] Failed to start PTY session for container ${containerId}:`, error);
        initialSocket.emit('terminal-error', { message: `Failed to start terminal: ${error.message || 'Unknown error'}` });
    }
}

// Function to watch container files for changes
async function setupFileWatcher(containerId: string) {
    try {
        // Check if we already have a watcher for this container
        if (containerFileWatchers.has(containerId)) {
            console.log(`[FileWatcher] Watcher already exists for container ${containerId}`);
            return;
        }

        // Get container info to determine volume mount path
        const container = await prisma.container.findUnique({
            where: { id: containerId },
            select: { projectId: true, templateId: true }
        });

        if (!container) {
            console.error(`[FileWatcher] Container ${containerId} not found in database`);
            return;
        }

        // For nodebasic template, watch the index.js file
        // In a real implementation, this would use Docker volume mounts
        // For this implementation, we'll watch the template directory
        const templateDir = path.resolve(__dirname, '../../../templates/nodebasic');
        const indexJsPath = path.join(templateDir, 'index.js');

        console.log(`[FileWatcher] Setting up watcher for ${indexJsPath}`);

        // Initialize modification time tracking
        if (!fileModificationTimes.has(containerId)) {
            fileModificationTimes.set(containerId, new Map());
        }

        // Get initial file stats
        try {
            const stats = fs.statSync(indexJsPath);
            fileModificationTimes.get(containerId)?.set(indexJsPath, stats.mtimeMs);
        } catch (err) {
            console.error(`[FileWatcher] Error getting initial file stats: ${err}`);
        }

        // Set up the file watcher
        const watcher = fs.watch(templateDir, (eventType, filename) => {
            if (filename === 'index.js') {
                try {
                    const stats = fs.statSync(indexJsPath);
                    const lastMtime = fileModificationTimes.get(containerId)?.get(indexJsPath) || 0;
                    
                    // Only emit change event if modification time has changed
                    if (stats.mtimeMs > lastMtime) {
                        console.log(`[FileWatcher] Detected change in ${filename} for container ${containerId}`);
                        
                        // Update modification time
                        fileModificationTimes.get(containerId)?.set(indexJsPath, stats.mtimeMs);
                        
                        // Emit event to all sockets in the container room
                        io.to(containerId).emit('file-changed', {
                            containerId,
                            path: `/workspace/${filename}`,
                            type: 'file',
                            event: eventType
                        });
                    }
                } catch (err) {
                    console.error(`[FileWatcher] Error checking file stats: ${err}`);
                }
            }
        });

        // Store the watcher
        containerFileWatchers.set(containerId, watcher);
        console.log(`[FileWatcher] Watcher set up for container ${containerId}`);

    } catch (error) {
        console.error(`[FileWatcher] Error setting up watcher for container ${containerId}:`, error);
    }
}

function cleanupFileWatcher(containerId: string) {
    const watcher = containerFileWatchers.get(containerId);
    if (watcher) {
        console.log(`[FileWatcher] Closing watcher for container ${containerId}`);
        watcher.close();
        containerFileWatchers.delete(containerId);
        fileModificationTimes.delete(containerId);
    }
}

// Helper function to find the full container ID from a partial ID
async function findFullContainerId(partialId: string): Promise<string | null> {
    try {
        // If the ID is already a full ID, return it
        if (partialId.length > 12) {
            return partialId;
        }
        
        // Find container by prefix
        const allContainers = await prisma.container.findMany({ select: { id: true } });
        const containerRecord = allContainers.find(c => c.id.startsWith(partialId));
        
        if (containerRecord) {
            return containerRecord.id;
        }
        
        return null;
    } catch (error) {
        console.error(`[API Internal] Error finding full container ID for ${partialId}:`, error);
        return null;
    }
}

function cleanupSocketResources(socketId: string, containerId: string | null) {
    // Remove from general room socket map
    if (containerId) {
        containerRoomSockets.get(containerId)?.delete(socketId);
        if (containerRoomSockets.get(containerId)?.size === 0) {
            containerRoomSockets.delete(containerId);
            // Clean up file watcher when no sockets are in the general room for this container
            // This might be too aggressive if PTY session still active, consider PTY socket count too
            // cleanupFileWatcher(containerId); // For now, let PTY disconnect handle PTY related watcher cleanup if any.
        }

        // Remove socket from its PTY session's active socket list
        const ptySession = activePtySessions.get(containerId);
        if (ptySession) {
            ptySession.sockets.delete(socketId);
            console.log(`[PTY] Socket ${socketId} removed from PTY on ${containerId}. Sockets remaining: ${ptySession.sockets.size}`);
        }
    }
}

// --- Internal API Endpoint for Watcher ---


app.post('/api/internal/filesystem-event', async (req: Request, res: Response) => {
    const eventData = req.body;
    console.log('[API Internal] Received FS Event:', JSON.stringify(eventData));

    const { containerId: shortContainerId, event, type, path: rawEventPath } = eventData;

    if (!shortContainerId || !event || !type || !rawEventPath || typeof rawEventPath !== 'string') {
        console.warn('[API Internal] Invalid FS event received:', eventData);
        return res.status(400).send('Invalid event data');
    }

    // --- 1. Normalize Path ---
    // Path from watcher is typically absolute within the container, starting with /workspace
    // Path in DB is stored relative to the logical workspace root, e.g., /index.js, /app/page.tsx
    let dbPath = rawEventPath;
    if (dbPath.startsWith('/workspace')) {
        dbPath = dbPath.substring('/workspace'.length); // Removes leading "/workspace"
        if (dbPath === '') { // If the path was exactly "/workspace"
            dbPath = '/'; // Represent the workspace root as "/" for DB lookup, or a specific designated marker
                           // This assumes your scan-workspace.js also creates a root File record with path "/" or "/workspace"
                           // For now, let's assume files inside workspace root are like "/index.js"
        }
    }
    // Ensure it always starts with a single slash if not already, unless it's the root itself
    if (dbPath !== '/' && !dbPath.startsWith('/')) {
        dbPath = '/' + dbPath;
    }
    console.log(`[API Internal] Watcher path: "${rawEventPath}", Normalized DB path: "${dbPath}"`);

    // --- 2. Find fullContainerId and ProjectId ---
    const fullContainerId = await findFullContainerId(shortContainerId); // Use your existing helper

    if (!fullContainerId) {
        console.error(`[API Internal] Full container ID not found for short ID: ${shortContainerId}. Cannot process event for path: ${dbPath}.`);
        // It's often better to send a 204 so the watcher doesn't get stuck retrying on a 404 for a container that might be legitimately gone.
        return res.status(204).send(); 
    }

    try {
        const containerRecord = await prisma.container.findUnique({
            where: { id: fullContainerId },
            select: { projectId: true }
        });

        if (!containerRecord) {
            console.error(`[API Internal] Container DB record not found for full ID: ${fullContainerId}. Cannot process event for path: ${dbPath}.`);
            return res.status(404).send('Container record not found in DB');
        }
        const projectId = containerRecord.projectId;
        let fileSystemNodeForBroadcast: FileSystemNode | null = null; // Type from @codeyarn/shared-types

        // --- 3. Process Event and Update Database ---
        if (event === 'create') {
            const name = path.basename(dbPath);
            // Determine parentDbPath for Prisma relation.
            // If dbPath is "/foo.txt", parentDbPath is "/".
            // If dbPath is "/bar/foo.txt", parentDbPath is "/bar".
            let parentDbPath = path.dirname(dbPath).replace(/\\/g, '/');
            if (parentDbPath === '.') parentDbPath = '/'; // Handles files directly in root, dirname of /foo.txt is .
            
            const isDirectory = type === 'directory';
            let parentId: string | null = null;

            if (parentDbPath !== '/') { // If not a direct child of the conceptual root
                const parentNode = await prisma.file.findUnique({
                    where: { projectId_path: { projectId, path: parentDbPath } },
                    select: { id: true, isDirectory: true }
                });
                if (parentNode && parentNode.isDirectory) {
                    parentId = parentNode.id;
                } else {
                    console.warn(`[API Internal] Parent node at DB path "${parentDbPath}" not found or not a directory for creating "${dbPath}". Will create as root-level.`);
                    // If specific parent isn't found, it becomes a child of the implicit project root.
                    // This requires your frontend/DB to handle root items having parentId: null or a specific root folder ID.
                    // For now, let's assume your initial scan creates a '/workspace' (or logical root like '/') File record.
                    // If scan-workspace.js creates a File record with path: "/workspace", find its ID.
                    const workspaceRootFileNode = await prisma.file.findUnique({ where: {projectId_path: {projectId, path: "/workspace"}}});
                    if(workspaceRootFileNode) parentId = workspaceRootFileNode.id;

                }
            } else { // It's a direct child of / (e.g. /index.js), parent is the /workspace node
                 const workspaceRootFileNode = await prisma.file.findUnique({ where: {projectId_path: {projectId, path: "/workspace"}}});
                 if(workspaceRootFileNode) parentId = workspaceRootFileNode.id;
            }


            const existingNode = await prisma.file.findUnique({ where: { projectId_path: { projectId, path: dbPath } } });
            if (existingNode) {
                console.warn(`[API Internal] Node ${dbPath} (event: create) reported by watcher already exists in DB. Updating timestamp and clearing content.`);
                const updatedNode = await prisma.file.update({
                    where: { id: existingNode.id },
                    data: { updatedAt: new Date(), content: isDirectory ? null : null, isDirectory: isDirectory /* in case type changed */ }
                });
                 fileSystemNodeForBroadcast = { ...updatedNode, createdAt: updatedNode.createdAt.toISOString(), updatedAt: updatedNode.updatedAt.toISOString(), content: updatedNode.content ?? undefined };
            } else {
                const newNode = await prisma.file.create({
                    data: {
                        name,
                        path: dbPath,
                        isDirectory,
                        projectId,
                        parentId,
                        content: isDirectory ? null : null, // Set content to null for files, so editor fetches fresh
                    }
                });
                console.log(`[API Internal] Created DB record for ${dbPath} (ID: ${newNode.id})`);
                fileSystemNodeForBroadcast = { ...newNode, createdAt: newNode.createdAt.toISOString(), updatedAt: newNode.updatedAt.toISOString(), content: newNode.content ?? undefined };
            }
        } else if (event === 'delete') {
            const nodeToDelete = await prisma.file.findUnique({
                where: { projectId_path: { projectId, path: dbPath } }, // Use normalized dbPath
                select: { id: true, isDirectory: true }
            });

            if (!nodeToDelete) {
                console.warn(`[API Internal] Node ${dbPath} not found in DB for delete event.`);
            } else {
                const idsToDelete: string[] = [nodeToDelete.id];
                if (nodeToDelete.isDirectory) {
                    const queue = [nodeToDelete.id];
                    while (queue.length > 0) {
                        const currentParentId = queue.shift()!;
                        const children = await prisma.file.findMany({ where: { parentId: currentParentId }, select: { id: true, isDirectory: true } });
                        children.forEach(child => { idsToDelete.push(child.id); if (child.isDirectory) queue.push(child.id); });
                    }
                }
                const deleteResult = await prisma.file.deleteMany({ where: { id: { in: idsToDelete } } });
                console.log(`[API Internal] Deleted ${deleteResult.count} DB record(s) for path ${dbPath}`);
            }
        } else if (event === 'modify') {
            const nodeToUpdate = await prisma.file.findUnique({
                 where: { projectId_path: { projectId, path: dbPath } },
                 select: { id: true, isDirectory: true } // Select isDirectory to avoid updating content for directories
            });
            if (!nodeToUpdate) {
                console.warn(`[API Internal] Node ${dbPath} not found for modify event. It might be a new file modified quickly.`);
                // Optionally, treat as create if it doesn't exist, but ensure content is handled
            } else {
                if (nodeToUpdate.isDirectory) {
                    await prisma.file.update({ where: { id: nodeToUpdate.id }, data: { updatedAt: new Date() }});
                    console.log(`[API Internal] Updated timestamp for modified directory: ${dbPath}`);
                } else {
                    // For files, update timestamp AND set content to null to trigger lazy load by editor.
                    await prisma.file.update({
                        where: { id: nodeToUpdate.id },
                        data: { updatedAt: new Date(), content: null }
                    });
                    console.log(`[API Internal] Updated timestamp and nulled content for modified file: ${dbPath}`);
                }
            }
        } else {
            console.warn(`[API Internal] Received unhandled event type: ${event} for path ${dbPath}`);
        }

        // --- 4. Broadcast Event via Socket.IO (using normalized dbPath) ---
        if (event === 'create' || event === 'delete' || event === 'modify') {
            io.to(fullContainerId).emit('fs-update', {
                containerId: fullContainerId,
                event,
                type, // type from watcher event data ('file' or 'directory')
                path: dbPath, // Use the normalized dbPath
                // For 'create', send the newly created node data (with ISO dates and potentially null content)
                ...(event === 'create' && fileSystemNodeForBroadcast && { node: fileSystemNodeForBroadcast }),
            });
            console.log(`[API Internal] Broadcasted 'fs-update' to room: ${fullContainerId} for event: ${event}, path: ${dbPath}`);
        }
        res.status(204).send();

    } catch (error: any) {
        console.error(`[API Internal Error] Failed to process FS event for container ${shortContainerId} (full: ${fullContainerId}), raw path ${rawEventPath} (DB path ${dbPath}):`, error);
        res.status(500).send('Internal Server Error');
    }
});


// --- Error Handling & Server Startup ---
app.use((req: Request, res: Response) => { res.status(404).json({ message: 'Not Found' }); });
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("[Error Handler]", err.stack);
    const errorMessage = process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message;
    res.status(500).json({ message: 'Internal Server Error', error: errorMessage });
 });
httpServer.listen(PORT, () => {
    console.log(`--------------------------------------`);
    console.log(`  CodeYarn Server listening on port ${PORT}`);
    console.log(`  Allowed CORS origin: ${CORS_ORIGIN}`);
    console.log(`--------------------------------------`);
 });
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    io.close(() => { console.log('[Socket.IO] Server closed.'); httpServer.close(() => { console.log('HTTP server closed.'); process.exit(0); }); });
});

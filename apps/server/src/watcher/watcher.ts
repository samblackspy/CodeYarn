// codeyarn/apps/server/src/watcher/watcher.ts

/**
 * watcher.ts
 *
 * This script runs *inside* the Docker container playground.
 * It uses `inotifywait` to monitor the /workspace directory for file changes
 * and sends notifications about these events to the main backend server's
 * internal API endpoint.
 */

import { spawn } from 'child_process';
import http from 'node:http'; // Use node: prefix for built-in modules
import path from 'node:path';

// --- Configuration ---
const WATCH_PATH = process.env.WATCH_PATH || '/workspace'; // Directory to watch inside the container
const BACKEND_HOST = process.env.BACKEND_HOST || 'host.docker.internal';
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '3001', 10); // Port the main backend server is listening on
const BACKEND_ENDPOINT = process.env.BACKEND_ENDPOINT || '/api/internal/filesystem-event';
const CONTAINER_ID = process.env.CONTAINER_ID;

const DEFAULT_EXCLUDE_PATTERN = '^(' +
    '/workspace/node_modules|' +
    '/workspace/\\.git|' +
    '/workspace/\\.next|' +
    '/workspace/\\.npm|' +        // For .npm
    '/workspace/\\.pnpm-store|' +
    '/workspace/\\.bash_history|' + // For .bash_history
    '/workspace/\\.ash_history|' +  // For .ash_history
    '/workspace/build|' +
    '/workspace/dist|' +
    '/workspace/\\.cache' +
')';

const EXCLUDE_PATTERN = process.env.EXCLUDE_PATTERN || DEFAULT_EXCLUDE_PATTERN;


if (!CONTAINER_ID) {
    console.error('[Watcher Error] CONTAINER_ID environment variable is not set. Exiting.');
    process.exit(1);
}

console.log(`[CodeYarn Watcher] Initializing...`);
console.log(`[CodeYarn Watcher] Container ID: ${CONTAINER_ID}`);
console.log(`[CodeYarn Watcher] Watching Path: ${WATCH_PATH}`);
console.log(`[CodeYarn Watcher] Excluding Pattern: ${EXCLUDE_PATTERN}`);
console.log(`[CodeYarn Watcher] Reporting events to: http://${BACKEND_HOST}:${BACKEND_PORT}${BACKEND_ENDPOINT}`);

// --- Function to send event data to backend ---
// Updated to explicitly require path as string
function sendEventToBackend(eventData: { event: string; type: string; path: string }) {
    const payload = JSON.stringify({
        containerId: CONTAINER_ID,
        ...eventData
    });

    const options: http.RequestOptions = {
        hostname: BACKEND_HOST,
        port: BACKEND_PORT,
        path: BACKEND_ENDPOINT,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
    };

    const req = http.request(options, (res) => {
        if (res.statusCode !== 204 && res.statusCode !== 200) {
            console.error(`[Watcher] Backend responded with status: ${res.statusCode}`);
        }
        res.resume();
    });

    req.on('error', (e) => {
        console.error(`[Watcher] Problem sending event to backend: ${e.message}`);
    });

    req.on('timeout', () => {
        console.error('[Watcher] Backend request timed out.');
        req.destroy();
    });

    req.write(payload);
    req.end();
}

// --- Start inotifywait ---
function startInotifywait() {
    console.log('[Watcher] Starting inotifywait process...');
    const args = [
        '-m', '-r', '-q',
        '--format', '%w%f %e',
        '-e', 'create', '-e', 'delete', '-e', 'modify',
        '-e', 'moved_to', '-e', 'moved_from',
        WATCH_PATH
    ];

if (EXCLUDE_PATTERN) {
    args.splice(args.length - 1, 0, '--exclude', EXCLUDE_PATTERN);
    console.log(`[CodeYarn Watcher] Effective Exclude Pattern for inotifywait: ${EXCLUDE_PATTERN}`);
}

    const watcherProcess = spawn('inotifywait', args);

    // --- Process inotifywait output ---
    watcherProcess.stdout.on('data', (data: Buffer) => {
        const outputLines = data.toString().trim().split('\n');
        outputLines.forEach(line => {
            if (!line) return;

            console.log(`[Watcher] Raw event: ${line}`);
            const parts = line.split(' ');
            // Explicitly check parts length and existence of required elements
            if (parts.length < 2 || typeof parts[0] !== 'string' || typeof parts[1] !== 'string') {
                console.warn(`[Watcher] Skipping malformed line (missing parts): ${line}`);
                return;
            }

            const fullPath: string = parts[0]; // Now guaranteed to be string
            const flagsString: string = parts[1]; // Now guaranteed to be string
            const flags = flagsString.split(',');

            let eventType: 'create' | 'delete' | 'modify' | null = null;
            const nodeType: 'file' | 'directory' = flags.includes('ISDIR') ? 'directory' : 'file';

            if (flags.includes('CREATE') || flags.includes('MOVED_TO')) {
                eventType = 'create';
            } else if (flags.includes('DELETE') || flags.includes('MOVED_FROM')) {
                eventType = 'delete';
            } else if (flags.includes('MODIFY')) {
                eventType = 'modify';
                if (nodeType === 'directory') {
                    console.log(`[Watcher] Skipping MODIFY event for directory: ${fullPath}`);
                    return;
                }
            } else {
                console.warn(`[Watcher] Skipping unhandled event flags: ${flags.join(',')} for path: ${fullPath}`);
                return;
            }

            // Ensure eventType is not null before proceeding
            if (eventType === null) {
                 console.warn(`[Watcher] Could not determine valid event type for flags: ${flags.join(',')}`);
                 return;
            }

            // Construct event data - path is now guaranteed to be string
            const eventData = {
                event: eventType,
                type: nodeType,
                path: fullPath,
            };

            console.log(`[Watcher] Parsed event:`, eventData);
            // Call the function - eventData now matches the expected parameter type
            sendEventToBackend(eventData);
        });
    });

    watcherProcess.stderr.on('data', (data: Buffer) => {
        console.error(`[Watcher] inotifywait stderr: ${data.toString().trim()}`);
    });

    watcherProcess.on('close', (code: number | null) => {
        console.warn(`[Watcher] inotifywait process exited with code ${code}. Restarting in 5 seconds...`);
        setTimeout(startInotifywait, 5000);
    });

    watcherProcess.on('error', (err: Error) => {
        console.error(`[Watcher] Failed to start or run inotifywait: ${err.message}. Retrying in 10 seconds...`);
        setTimeout(startInotifywait, 10000);
    });
}

// --- Initial Start ---
startInotifywait();

console.log('[CodeYarn Watcher] Script setup complete. Monitoring...');

// codeyarn/apps/server/src/watcher/watcher.ts

/**
 * watcher.ts
 *
 * This script runs *inside* the Docker container playground.
 * It uses `inotifywait` to monitor the /workspace directory for file changes
 * and sends notifications about these events to the main backend server's
 * internal API endpoint.
 */

import { spawn } from "child_process"; // To run external commands like inotifywait.
import http from "node:http"; // For making HTTP requests to the backend.
 
// --- Configuration (loaded from environment variables or defaults) ---
// Directory to watch inside the container (e.g., /workspace).
const WATCH_PATH = process.env.WATCH_PATH || "/workspace";
// Hostname of the main backend server (e.g., host.docker.internal to reach host from container).
const BACKEND_HOST = process.env.BACKEND_HOST || "host.docker.internal";
// Port the main backend server is listening on.
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || "3001", 10);
// API endpoint on the backend to send filesystem events to.
const BACKEND_ENDPOINT =
  process.env.BACKEND_ENDPOINT || "/api/internal/filesystem-event";
// Unique ID of the container this watcher is running in.
const CONTAINER_ID = process.env.CONTAINER_ID;

// Default regex pattern to exclude common directories/files from watching.
const DEFAULT_EXCLUDE_PATTERN =
  "^(" +
  "/workspace/node_modules|" +
  "/workspace/\\.git|" +
  "/workspace/\\.next|" +
  "/workspace/\\.npm|" + // For .npm cache/lock files if stored in workspace.
  "/workspace/\\.pnpm-store|" + // For pnpm's content-addressable store if in workspace.
  "/workspace/\\.bash_history|" + // For shell history files.
  "/workspace/\\.ash_history|" + // For Alpine's ash shell history.
  "/workspace/build|" + // Common build output directory.
  "/workspace/dist|" + // Common distribution output directory.
  "/workspace/\\.cache" + // Common caching directory.
  ")";
// Use environment variable for exclude pattern if provided, otherwise use default.
const EXCLUDE_PATTERN = process.env.EXCLUDE_PATTERN || DEFAULT_EXCLUDE_PATTERN;

// Critical check: CONTAINER_ID must be set for the watcher to identify its events.
if (!CONTAINER_ID) {
  console.error(
    "[Watcher Error] CONTAINER_ID environment variable is not set. Exiting."
  );
  process.exit(1); // Exit if no CONTAINER_ID.
}

// Log initial configuration upon starting.
console.log(`[CodeYarn Watcher] Initializing...`);
console.log(`[CodeYarn Watcher] Container ID: ${CONTAINER_ID}`);
console.log(`[CodeYarn Watcher] Watching Path: ${WATCH_PATH}`);
console.log(`[CodeYarn Watcher] Excluding Pattern: ${EXCLUDE_PATTERN}`);
console.log(
  `[CodeYarn Watcher] Reporting events to: http://${BACKEND_HOST}:${BACKEND_PORT}${BACKEND_ENDPOINT}`
);

// --- Function to send event data to backend ---
/**
 * Sends a parsed filesystem event to the main backend server.
 * @param eventData - The event data to send, including event type, node type, and path.
 */
function sendEventToBackend(eventData: {
  event: string; // Type of filesystem event (e.g., 'create', 'delete', 'modify').
  type: string; // Type of filesystem node (e.g., 'file', 'directory').
  path: string; // Full path of the affected node.
}) {
  // Construct the payload to send, including the containerId.
  const payload = JSON.stringify({
    containerId: CONTAINER_ID,
    ...eventData,
  });

  // Define HTTP request options for sending the event to the backend.
  const options: http.RequestOptions = {
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: BACKEND_ENDPOINT,
    method: "POST", // Use POST method to send data.
    headers: {
      "Content-Type": "application/json", // Indicate JSON payload.
      "Content-Length": Buffer.byteLength(payload), // Set content length for the payload.
    },
    timeout: 5000, // Set a 5-second timeout for the request.
  };

  // Create the HTTP request.
  const req = http.request(options, (res) => {
    // Check backend response status code; log if not successful (204 No Content or 200 OK).
    if (res.statusCode !== 204 && res.statusCode !== 200) {
      console.error(
        `[Watcher] Backend responded with status: ${res.statusCode}`
      );
    }
    // Ensure the response data is consumed to free up resources.
    res.resume();
  });

  // Handle errors during the request (e.g., network issues).
  req.on("error", (e) => {
    console.error(`[Watcher] Problem sending event to backend: ${e.message}`);
  });

  // Handle request timeout.
  req.on("timeout", () => {
    console.error("[Watcher] Backend request timed out.");
    req.destroy(); // Destroy the request on timeout.
  });

  // Write the payload to the request body and send the request.
  req.write(payload);
  req.end();
}

// --- Function to start and manage the inotifywait process ---
function startInotifywait() {
  console.log("[Watcher] Starting inotifywait process...");
  // Define arguments for the inotifywait command.
  const args = [
    "-m", // Monitor: Keep running and output events indefinitely.
    "-r", // Recursive: Watch directories and their subdirectories.
    "-q", // Quiet: Suppress informational messages from inotifywait itself.
    "--format",
    "%w%f %e", // Output format: <watched_path><filename> <events_comma_separated>
    "-e",
    "create", // Watch for file/directory creation.
    "-e",
    "delete", // Watch for file/directory deletion.
    "-e",
    "modify", // Watch for file modification.
    "-e",
    "moved_to", // Watch for files/directories moved into the watched area.
    "-e",
    "moved_from", // Watch for files/directories moved out of the watched area.
    WATCH_PATH, // The directory to watch.
  ];

  // If an exclude pattern is defined, add it to the inotifywait arguments.
  if (EXCLUDE_PATTERN) {
    // Insert --exclude and its pattern before the WATCH_PATH argument.
    args.splice(args.length - 1, 0, "--exclude", EXCLUDE_PATTERN);
    console.log(
      `[CodeYarn Watcher] Effective Exclude Pattern for inotifywait: ${EXCLUDE_PATTERN}`
    );
  }

  // Spawn the inotifywait process.
  const watcherProcess = spawn("inotifywait", args);

  // --- Process inotifywait's standard output (where events are reported) ---
  watcherProcess.stdout.on("data", (data: Buffer) => {
    // Convert buffer data to string, trim whitespace, and split into lines (for multiple events).
    const outputLines = data.toString().trim().split("\n");
    outputLines.forEach((line) => {
      if (!line) return; // Skip empty lines.

      console.log(`[Watcher] Raw event: ${line}`);
      // Parse the formatted line from inotifywait.
      const parts = line.split(" ");
      // Basic validation for the parsed line.
      if (
        parts.length < 2 || // Expecting at least path and event_flags.
        typeof parts[0] !== "string" ||
        typeof parts[1] !== "string"
      ) {
        console.warn(
          `[Watcher] Skipping malformed line (missing parts): ${line}`
        );
        return;
      }

      const fullPath: string = parts[0]; // The full path of the affected file/directory.
      const flagsString: string = parts[1]; // Comma-separated event flags.
      const flags = flagsString.split(","); // Array of event flags.

      // Determine the event type (create, delete, modify) and node type (file, directory).
      let eventType: "create" | "delete" | "modify" | null = null;
      const nodeType: "file" | "directory" = flags.includes("ISDIR")
        ? "directory"
        : "file";

      // Map inotify flags to standardized event types.
      if (flags.includes("CREATE") || flags.includes("MOVED_TO")) {
        eventType = "create";
      } else if (flags.includes("DELETE") || flags.includes("MOVED_FROM")) {
        eventType = "delete";
      } else if (flags.includes("MODIFY")) {
        eventType = "modify";
        // Skip MODIFY events for directories as they are often noisy and less useful here.
        if (nodeType === "directory") {
          console.log(
            `[Watcher] Skipping MODIFY event for directory: ${fullPath}`
          );
          return;
        }
      } else {
        // Log and skip event types not explicitly handled.
        console.warn(
          `[Watcher] Skipping unhandled event flags: ${flags.join(",")} for path: ${fullPath}`
        );
        return;
      }

      // Ensure a valid eventType was determined.
      if (eventType === null) {
        console.warn(
          `[Watcher] Could not determine valid event type for flags: ${flags.join(",")}`
        );
        return;
      }

      // Construct the event data object to send to the backend.
      const eventData = {
        event: eventType,
        type: nodeType,
        path: fullPath, // Path is directly from inotifywait, e.g., /workspace/path/to/file.
      };

      console.log(`[Watcher] Parsed event:`, eventData);
      // Send the parsed event to the backend.
      sendEventToBackend(eventData);
    });
  });

  // Handle standard error output from inotifywait.
  watcherProcess.stderr.on("data", (data: Buffer) => {
    console.error(`[Watcher] inotifywait stderr: ${data.toString().trim()}`);
  });

  // Handle the 'close' event for the inotifywait process (e.g., if it exits).
  watcherProcess.on("close", (code: number | null) => {
    console.warn(
      `[Watcher] inotifywait process exited with code ${code}. Restarting in 5 seconds...`
    );
    // Attempt to restart inotifywait after a delay.
    setTimeout(startInotifywait, 5000);
  });

  // Handle errors related to spawning or running the inotifywait process itself.
  watcherProcess.on("error", (err: Error) => {
    console.error(
      `[Watcher] Failed to start or run inotifywait: ${err.message}. Retrying in 10 seconds...`
    );
    // Attempt to restart inotifywait after a longer delay.
    setTimeout(startInotifywait, 10000);
  });
}

// --- Initial Start ---
// Start the inotifywait monitoring process when the script begins.
startInotifywait();

console.log("[CodeYarn Watcher] Script setup complete. Monitoring...");

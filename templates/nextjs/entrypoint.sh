#!/bin/sh
# entrypoint.sh - Runs inside the container

# Exit immediately if a command exits with a non-zero status.
set -e

echo "[Entrypoint] Starting CodeYarn Next.js Environment..."
echo "[Entrypoint] Working Directory: $(pwd)"

# --- Determine Container ID ---
# Use the hostname command, which Docker typically sets to the container's short ID.
# The watcher script can then use this environment variable.
export CONTAINER_ID=$(hostname)
echo "[Entrypoint] Determined Container ID: ${CONTAINER_ID}"

# --- Start the File Watcher ---
# Run the compiled watcher script in the background using Node.js
# It will pick up CONTAINER_ID and other BACKEND_* variables from the environment
echo "[Entrypoint] Launching file watcher (Node process)..."
node /app/watcher.js &
# Store the process ID (PID) of the watcher
WATCHER_PID=$!
echo "[Entrypoint] File watcher started with PID: $WATCHER_PID"

# Give the watcher a moment to initialize (optional)
sleep 1

# --- Execute the Main Command ---
# The main command for the playground is passed as arguments ($@) from the Dockerfile CMD
# or the 'docker run' command.
echo "[Entrypoint] Executing main command: $@"

# Use 'exec' to replace the shell process with the main command.
# This ensures the main command receives signals (like SIGTERM) correctly.
exec "$@"

# Note: Code below 'exec' will not run unless 'exec' fails.
# Traps might not work reliably after 'exec'. Container stop signals are handled by Docker.
echo "[Entrypoint] Main command finished (or exec failed)."


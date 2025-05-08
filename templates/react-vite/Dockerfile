# Use an official Node.js runtime as a parent image
FROM node:18-alpine

WORKDIR /workspace

# --- Install Dependencies ---
# Install git, inotify-tools, and potentially build essentials if needed later
RUN apk add --no-cache git inotify-tools

# --- Application Code (Example assuming Vite project) ---
# Copy package manager files
# COPY package*.json ./
# COPY pnpm-lock.yaml ./

# Install dependencies
# RUN pnpm install --frozen-lockfile

# Copy application source code
# COPY . .

# Optional: Build step if needed for production preview (less common for dev playgrounds)
# RUN pnpm run build

# --- Watcher Setup ---
# Copy the compiled watcher script
COPY apps/server/dist/watcher/watcher.js /app/watcher.js

# --- Entrypoint ---
# Copy and set execute permission for the entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Expose the default Vite port
EXPOSE 5173

# Run the entrypoint script
ENTRYPOINT ["/app/entrypoint.sh"]

# Default command (often overridden by user's dev command)
# CMD ["pnpm", "run", "dev", "--host", "0.0.0.0"] # Example default command

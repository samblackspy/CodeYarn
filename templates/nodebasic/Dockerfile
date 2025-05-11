# Use an official Node.js runtime as a parent image (Alpine Linux version)
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /workspace

# --- Install Dependencies ---
# Install necessary tools: git (common for dev), and inotify-tools for the watcher
# Update apk cache first, then install, then clean up cache
RUN apk update && apk add --no-cache git inotify-tools && rm -rf /var/cache/apk/*

# Add the 'coder' user for compatibility with CodeYarn
RUN adduser -D coder && \
    mkdir -p /workspace && \
    chown -R coder:coder /workspace && \
    chmod -R 755 /workspace

# --- Application Code ---
# This section depends heavily on your specific template structure.
# Usually involves copying package.json/lock files, installing dependencies,
# and copying source code. These are placeholders.

# Example: Copy package manager files (assuming they exist in the template dir or context)
# COPY package.json pnpm-lock.yaml ./
# Example: Install dependencies (using pnpm in this example)
# RUN npm install -g pnpm && pnpm install --frozen-lockfile
# Example: Copy application source code (assuming it exists in the template dir or context)
# COPY . .

# --- Watcher and Entrypoint Setup ---
# Create directory for scripts if it doesn't exist
RUN mkdir -p /app

# Copy the compiled watcher script from the server's build output
# IMPORTANT: Adjust source path based on your Docker build context.
# This assumes the context is the monorepo root.
COPY apps/server/dist/watcher/watcher.js /app/watcher.js
# Install global tools as root
RUN npm install -g nodemon

# Copy system scripts
COPY templates/nodebasic/scan-workspace.js /usr/local/bin/scan-workspace.js
RUN chmod +x /usr/local/bin/scan-workspace.js
COPY templates/nodebasic/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Copy template files to workspace (as root)
COPY templates/nodebasic/package.json /workspace/package.json
COPY templates/nodebasic/index.js /workspace/index.js

# Change ownership of all workspace files to coder
RUN chown -R coder:coder /workspace/*

# Switch to coder user for container runtime
USER coder

# --- Container Execution ---
# Expose the default port (informational)
EXPOSE 3000

# Run the entrypoint script when the container launches
# The entrypoint script will execute the CMD as its main process
ENTRYPOINT ["/app/entrypoint.sh"]

# Define the default command to be executed by the entrypoint script
# This should be the primary process for this template (e.g., starting the dev server)
CMD ["npm", "run", "dev"]

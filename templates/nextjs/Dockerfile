# Dockerfile for codeyarn-nextjs:latest (and similar for other templates)

# Use an official Node.js LTS runtime as a parent image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /workspace

# --- Install System Dependencies ---
# git is useful, inotify-tools for the CodeYarn watcher, su-exec for user switching in entrypoint if needed
RUN apk update && \
    apk add --no-cache git inotify-tools && \
    rm -rf /var/cache/apk/*

# --- Create 'coder' User & Setup /workspace Directory ---
RUN mkdir -p /workspace && \
    adduser -D -h /workspace coder && \
    chown -R coder:coder /workspace && \
    chmod -R 755 /workspace

# --- Copy Utility Scripts (Watcher, Entrypoint, Scan Script) ---
# These are copied as root and placed in system paths.
RUN mkdir -p /app

# Path relative to the build context (e.g., /root/CodeYarn/)
COPY apps/server/dist/watcher/watcher.js /app/watcher.js

COPY templates/nextjs/scan-workspace.js /usr/local/bin/scan-workspace.js
 # Adjust 'nextjs' for other templates
RUN chmod +x /usr/local/bin/scan-workspace.js
COPY templates/nextjs/entrypoint.sh /app/entrypoint.sh 
# Adjust 'nextjs' for other templates
RUN chmod +x /app/entrypoint.sh

# --- Copy Application Code Skeleton ---
# These files form the project skeleton. They are copied as root first.
# Source paths are relative to the build context (e.g., /root/CodeYarn/)

COPY templates/nextjs/myapp/package.json /workspace/package.json
# If you have a package-lock.json in your myapp, copy it too.
# COPY templates/nextjs/myapp/package-lock.json /workspace/package-lock.json

COPY templates/nextjs/myapp/next.config.ts /workspace/next.config.ts
COPY templates/nextjs/myapp/tsconfig.json /workspace/tsconfig.json
COPY templates/nextjs/myapp/postcss.config.mjs /workspace/postcss.config.mjs
# COPY templates/nextjs/myapp/.eslintrc.json /workspace/ # If it exists
# COPY templates/nextjs/myapp/tailwind.config.js /workspace/ # If it exists

COPY templates/nextjs/myapp/app /workspace/app
COPY templates/nextjs/myapp/public /workspace/public
# DO NOT COPY node_modules from your host

# --- Set Ownership for Workspace Files ---
# Ensure all files COPIED into /workspace are owned by 'coder'.
RUN chown -R coder:coder /workspace

# --- Set Default User for Running Container ---
# This makes the ENTRYPOINT and CMD run as 'coder'.
# Also, terminal sessions opened via 'docker exec' will default to 'coder'.
USER coder

# --- NO 'npm install' or 'npm ci' during build ---
# This step is now skipped. The user will run it manually.

# --- Container Execution Configuration ---
# EXPOSE is still useful metadata, indicating the port the app WILL listen on once started.
EXPOSE 3000 
# For Next.js (e.g., 5173 for Vite)

# ENTRYPOINT script will run as the 'coder' user.
ENTRYPOINT ["/app/entrypoint.sh"]

# The CMD is now simply /bin/sh.
# Your entrypoint.sh will execute this, dropping the user into a shell as 'coder'.
CMD ["/bin/sh"]

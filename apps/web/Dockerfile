# apps/web/Dockerfile

# ---- Base Stage ----
# Use a Node.js version that matches your project's requirements (e.g., >=18)
FROM node:18-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm

# Set working directory
WORKDIR /app

# ---- Dependencies Stage ----
FROM base AS deps
# Copy root package.json, pnpm-lock.yaml, pnpm-workspace.yaml, and .npmrc (if it exists)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* .npmrc* ./
# Copy turbo.json
COPY turbo.json ./
# Copy application-specific package.json files
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
# Copy packages (or at least their package.json files if more granular control is needed)
# For simplicity, if 'packages' isn't too large, copy it. Otherwise, copy only package.json from each.
COPY packages ./packages/

# Install dependencies using pnpm, filtering for the web app and its dependencies
# This leverages Turborepo's knowledge of the dependency graph.
RUN pnpm install --filter @codeyarn/web... --prod=false --frozen-lockfile


# ---- Builder Stage ----
FROM base AS builder
WORKDIR /app
# Copy necessary files from deps stage (node_modules, package files, turbo.json)
COPY --from=deps /app/node_modules ./node_modules/
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /app/pnpm-workspace.yaml* ./
COPY --from=deps /app/.npmrc* ./
COPY --from=deps /app/turbo.json ./
COPY --from=deps /app/apps ./apps/
COPY --from=deps /app/packages ./packages/

# Copy the rest of your application code
# (Adjust if your tsconfig paths or other dependencies are outside these dirs)
COPY apps/web/tsconfig.json ./tsconfig.json
COPY apps/web/.eslintrc.js ./
# Or your eslint config file name
# If you have specific typescript configs for the workspace, copy them too
# e.g., COPY packages/typescript-config ./packages/typescript-config

# Build the web application
# Turborepo will ensure only necessary parts are built.
RUN pnpm turbo build --filter=@codeyarn/web

# ---- Runner Stage ----
FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm

# Copy only the necessary built artifacts for the web app from the builder stage
# This relies on Turborepo's "out" directory structure or Next.js's default output.
# We need the root package.json for 'next start' to work correctly with workspaces.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml* ./
COPY --from=builder /app/.npmrc* ./
# Copy the built web app
COPY --from=builder /app/apps/web/.next ./apps/web/.next/
COPY --from=builder /app/apps/web/public ./apps/web/public/
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/node_modules ./node_modules/
# If next.config.js is crucial at runtime and not bundled, copy it
COPY --from=builder /app/apps/web/next.config.js ./apps/web/next.config.js


# For Next.js in standalone output mode (recommended for smaller images)
# If you enable 'output: "standalone"' in next.config.js:
# COPY --from=builder /app/apps/web/.next/standalone ./
# COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# COPY --from=builder /app/apps/web/public ./apps/web/public
# WORKDIR /app/apps/web # If using standalone, adjust WORKDIR and CMD

# Change to the web app's directory
WORKDIR /app/apps/web

# Expose port 3000 (Next.js default)
EXPOSE 3000

# Start command for Next.js
# The PWD will be /app/apps/web, next start should work from here.
# We use pnpm to run next, consistent with monorepo tooling.
# Ensure the script exists in apps/web/package.json
CMD ["pnpm", "start"]

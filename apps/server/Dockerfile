# apps/server/Dockerfile

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
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/ 
# For workspace resolution
# Copy packages (or at least their package.json files)
COPY packages ./packages/

# Install dependencies using pnpm, filtering for the server app and its dependencies
# Install production dependencies only for the server itself in the final stage if possible,
# but for building TypeScript, we often need devDependencies.
RUN pnpm install --filter @codeyarn/server... --prod=false --frozen-lockfile

# ---- Builder Stage ----
FROM base AS builder
WORKDIR /app
# Copy necessary files from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /app/pnpm-workspace.yaml* ./
COPY --from=deps /app/.npmrc* ./
COPY --from=deps /app/turbo.json ./
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages

# Copy tsconfig files
COPY tsconfig.json ./
# Ensure apps/server/tsconfig.json is also copied if it's referenced by the build script or extends the root one.
# The COPY apps ./apps above should cover this.

# Copy Prisma schema if it's not in packages/db, or ensure packages/db is copied.
# Assuming schema is in packages/db, which is copied.
# If `prisma generate` is part of your local build flow and needed before `tsc`, add it here.
# e.g., RUN pnpm --filter @codeyarn/db exec prisma generate

# Build the server application (TypeScript compilation)
# Turborepo will ensure only necessary parts are built.
RUN pnpm turbo build --filter=@codeyarn/server

# ---- Runner Stage ----
FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm

# Copy only the necessary production build artifacts and dependencies
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml* ./
COPY --from=builder /app/.npmrc* ./

# Selectively copy production node_modules for the server.
# Create a temporary location for pruned production dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/packages ./packages 
# For workspace symlinks, may need to be more specific

# Prune dev dependencies from the copied node_modules specific to the server
# This requires copying the server's package.json and then running pnpm install --prod
# Alternatively, if the build output (dist) is self-contained with its package.json:
# COPY --from=builder /app/apps/server/dist ./apps/server/dist
# COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
# WORKDIR /app/apps/server
# RUN pnpm install --prod --frozen-lockfile # This would require pnpm-lock.yaml too.

# A simpler approach for monorepos is often to copy the relevant parts of node_modules
# or rely on the fact that the build output from `tsc` is in `apps/server/dist`.
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/

# Copy prisma client generation files if needed by the server at runtime and not bundled
# This depends on how Prisma client is generated and used.
# If it's in node_modules/@prisma/client and node_modules is copied, it should be fine.
# If it's generated into packages/db/generated, ensure that path is copied.
# COPY --from=builder /app/packages/db/generated ./packages/db/generated

# Set working directory to the server app's context
WORKDIR /app/apps/server

# Expose port 3001 (or whatever port your Express server listens on)
EXPOSE 3001

# Command to run the server
# Ensure this matches your server's package.json start script and output directory.
# We use pnpm start, which should execute `node dist/index.js` as per package.json
CMD ["pnpm", "start"]

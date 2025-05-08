/**
 * Represents the structure of a file or folder within a project's workspace.
 * This will be stored persistently in the database and used to represent
 * the state in the File Explorer UI.
 */
export interface FileSystemNode {
  id: string; // Unique identifier (e.g., UUID or database ID)
  name: string; // Name of the file or folder (e.g., "index.ts", "components")
  path: string; // Full path within the workspace (e.g., "/src/components/Button.tsx")
  projectId: string; // ID of the project this node belongs to
  parentId: string | null; // ID of the parent folder node, null for root level items
  isDirectory: boolean; // True if it's a folder, false if it's a file
  content?: string; // Content of the file (loaded on demand, not always present)
  createdAt: string; // ISO 8601 date string
  updatedAt: string; // ISO 8601 date string
}

/**
 * Represents the possible statuses of a Docker container playground.
 * Uses uppercase to match Prisma Enum definition.
 */
export type ContainerStatus = 'CREATING' | 'RUNNING' | 'STOPPED' | 'ERROR' | 'DELETED' | 'UNKNOWN'; // <-- Use UPPERCASE

/**
 * Represents the Docker container instance acting as the playground environment.
 * This information is primarily managed by the backend and stored persistently.
 */
export interface Container {
  id: string; // Docker container ID
  projectId: string; // ID of the project this container serves
  templateId: string; // ID of the template used to create this container
  status: ContainerStatus; // Uses the uppercase type
  hostPort: number | null; // The port on the host machine mapped to the container's primary service port (e.g., 3000)
  createdAt: string; // ISO 8601 date string
  startedAt?: string; // ISO 8601 date string, when last started
  stoppedAt?: string; // ISO 8601 date string, when last stopped
}

/**
 * Represents a project template (e.g., React, Next.js, Node.js).
 * These definitions might be stored in the database or configuration files.
 */
export interface Template {
  id: string; // Unique identifier for the template (e.g., "nextjs-ts")
  name: string; // Display name (e.g., "Next.js (TypeScript)")
  description: string; // Brief description of the template
  iconUrl?: string; // Optional URL for an icon
  tags: string[]; // Keywords for searching/filtering (e.g., ["react", "ssr", "frontend"])
  dockerImage: string; // The Docker image to use for this template
  repositoryUrl?: string; // Optional URL to the source/starter repository
  startCommand?: string; // Default command to run (e.g., "npm run dev")
  defaultPort: number; // The default port the application inside the container listens on (e.g., 3000)
}

/**
 * Represents a user of the CodeYarn platform.
 * This would typically be stored in the database.
 */
export interface User {
  id: string; // Unique user ID (e.g., from auth provider or database)
  name?: string; // User's display name
  email: string; // User's email address
  avatarUrl?: string; // URL to the user's profile picture
  createdAt: string; // ISO 8601 date string
}

/**
 * Represents a user's project within CodeYarn.
 * This is a central entity stored in the database, linking users,
 * templates, containers, and files.
 */
export interface Project {
  id: string; // Unique project identifier (e.g., UUID or database ID)
  name: string; // User-defined name for the project
  description?: string; // Optional project description
  templateId: string; // ID of the template used for this project
  ownerId: string; // ID of the user who owns the project
  // collaborators?: User[]; // Future enhancement: list of collaborators
  containerId: string | null; // ID of the associated Docker container (when active)
  createdAt: string; // ISO 8601 date string
  updatedAt: string; // ISO 8601 date string
  lastAccessedAt?: string; // Optional: ISO 8601 date string
}

/**
 * Represents the visibility state of different panels in the IDE UI.
 * This is typically frontend state, but could be persisted as user preference.
 */
export interface PanelState {
  explorer: boolean;
  terminal: boolean;
  preview: boolean;
  // Add other panels as needed (e.g., settings, debugger)
}

/**
 * Represents the available UI themes.
 */
export type Theme = 'light' | 'dark' | 'system';


// --- WebSocket Event Payloads ---

/**
 * Payload for file system update events broadcast from the backend.
 */
export interface FileSystemUpdatePayload {
  containerId: string; // Identifies the relevant container/project
  event: 'create' | 'delete' | 'modify'; // Type of change
  type: 'file' | 'directory'; // Type of node affected
  path: string; // Full path of the affected node within the workspace
  // Optionally include the node data itself for 'create' events
  node?: FileSystemNode;
}

/**
 * Payload for terminal output events.
 */
export interface TerminalOutputPayload {
    containerId: string;
    output: string; // Chunk of output data from the container's PTY
}

/**
 * Payload for terminal command results (optional, for specific feedback).
 */
export interface CommandResultPayload {
    containerId: string;
    output?: string; // Final combined output (if needed)
    error?: string; // Error message if command failed
    exitCode?: number; // Exit code of the command
    final: boolean; // Indicates the command process has finished
}


// Add other shared types as needed (e.g., API request/response types, specific error types)

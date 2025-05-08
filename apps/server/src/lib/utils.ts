// codeyarn/apps/server/src/lib/utils.ts
import { FileSystemNode } from '@codeyarn/shared-types';

/**
 * FileStructureNode: Represents a node in the hierarchical tree structure
 * sent to the frontend. Dates are converted to ISO strings.
 * Content is omitted as it's not needed for the tree view.
 */
export interface FileStructureNode extends Omit<FileSystemNode, 'content' | 'createdAt' | 'updatedAt'> {
    createdAt: string; // Dates converted to ISO strings
    updatedAt: string;
    children?: FileStructureNode[]; // Optional children array for directories
}

/**
 * PrismaFileNode: Represents the type structure expected directly from
 * Prisma queries for File nodes before date conversion.
 */
export type PrismaFileNode = Omit<FileSystemNode, 'content' | 'createdAt' | 'updatedAt'> & {
    createdAt: Date; // Prisma returns Date objects
    updatedAt: Date;
};


/**
 * Builds a hierarchical tree structure from a flat list of file nodes
 * fetched from Prisma. Creates a virtual root node for the workspace.
 *
 * @param {PrismaFileNode[]} nodes - The flat list of file nodes from the database.
 * @param {string} [projectId='unknown'] - The ID of the project these nodes belong to.
 * @returns {FileStructureNode | null} The root node of the hierarchical tree, or null if input is empty.
 */
export function buildTreeFromFlatList(nodes: PrismaFileNode[], projectId: string = 'unknown'): FileStructureNode | null {
    // Handle empty input immediately
    if (!nodes || nodes.length === 0) {
        // Return a default virtual root for an empty project
         return {
            id: 'root',
            name: 'workspace',
            path: '/workspace',
            projectId: projectId, // Use provided projectId
            parentId: null,
            isDirectory: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            children: []
         };
    }

    const nodeMap = new Map<string, FileStructureNode>(); // Map: Node ID -> Tree Node
    const rootNodes: FileStructureNode[] = []; // Array to hold top-level nodes

    // --- First Pass: Create map entries and identify root nodes ---
    nodes.forEach(dbNode => {
        // Create the tree node structure, converting dates to ISO strings
        const treeNode: FileStructureNode = {
            id: dbNode.id,
            name: dbNode.name,
            path: dbNode.path,
            projectId: dbNode.projectId,
            parentId: dbNode.parentId,
            isDirectory: dbNode.isDirectory,
            createdAt: dbNode.createdAt.toISOString(), // Convert Date
            updatedAt: dbNode.updatedAt.toISOString(), // Convert Date
            // Add children array only for directories
            ...(dbNode.isDirectory && { children: [] })
        };
        // Add the node to the map using its ID as the key
        nodeMap.set(treeNode.id, treeNode);

        // If the node has no parentId, it's a root node within the project
        if (treeNode.parentId === null) {
            rootNodes.push(treeNode);
        }
    });

    // --- Second Pass: Link children to their parents ---
    nodeMap.forEach(treeNode => {
        // If the node has a parentId, find the parent in the map
        if (treeNode.parentId !== null) {
            const parent = nodeMap.get(treeNode.parentId);
            // If the parent exists and has a children array (i.e., is a directory)
            if (parent?.children) {
                parent.children.push(treeNode); // Add the current node as a child
            } else {
                 // Log a warning for orphan nodes or nodes whose parent isn't marked as a directory
                 console.warn(`[buildTree] Orphan node or invalid parent found: ${treeNode.path} (parentId: ${treeNode.parentId})`);
                 // Depending on requirements, orphan nodes could be added to rootNodes or ignored
            }
        }
    });

     // --- Sort children recursively (folders first, then alphabetically) ---
     const sortChildren = (node: FileStructureNode) => {
        if (node.children) { // Check if children array exists
            node.children.sort((a, b) => {
                // Sort directories before files
                if (a.isDirectory !== b.isDirectory) {
                    return a.isDirectory ? -1 : 1;
                }
                // Sort alphabetically by name
                return a.name.localeCompare(b.name);
            });
            // Recursively sort the children of children
            node.children.forEach(sortChildren);
        }
    };
    // Sort all root nodes and their descendants
    rootNodes.forEach(sortChildren);
    // Sort the root nodes themselves
    rootNodes.sort((a, b) => {
         if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
         return a.name.localeCompare(b.name);
    });


    // --- Create a virtual root node ---
    // This acts as the top-level container for the file explorer UI
    const virtualRoot: FileStructureNode = {
        id: 'root', // Special ID for the virtual root
        name: 'workspace', // Display name for the root
        path: '/workspace', // Conceptual root path
        projectId: projectId, // Assign the project ID
        parentId: null,
        isDirectory: true,
        createdAt: new Date().toISOString(), // Placeholder date
        updatedAt: new Date().toISOString(), // Placeholder date
        children: rootNodes // Assign the processed top-level nodes as children
    };

    return virtualRoot;
}

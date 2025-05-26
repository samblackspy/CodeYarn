// src/api/internalFSRouter.ts
import { Router, Request, Response } from "express";
import path from "node:path"; // Using node: prefix for built-in modules
import prisma from "@codeyarn/db";
import { FileSystemNode } from "@codeyarn/shared-types";
import { findFullContainerId } from "../services/containerService"; // Adjusted path assuming service location
import { io } from "../socket/ioServer"; // For broadcasting updates

const router = Router();

/**
 * POST /api/internal/filesystem-event
 * Endpoint for receiving filesystem change events from in-container watchers.
 * It updates the database and broadcasts changes to connected clients via Socket.IO.
 */
router.post(
  "/internal/filesystem-event",
  async (req: Request, res: Response) => {
    const eventData = req.body;
    console.log("[API Internal] Received FS Event:", JSON.stringify(eventData));

    // --- 1. Validate Incoming Event Data ---
    const {
      containerId: shortContainerId,
      event,
      type,
      path: rawEventPath,
    } = eventData;

    if (
      !shortContainerId ||
      !event ||
      !type ||
      !rawEventPath ||
      typeof rawEventPath !== "string"
    ) {
      console.warn(
        "[API Internal] Invalid FS event received (missing fields or wrong types):",
        eventData
      );
      return res
        .status(400)
        .send(
          "Invalid event data: missing required fields or incorrect types."
        );
    }

    // --- 2. Normalize Path from Watcher ---
    // Watcher path is typically absolute inside container (e.g., /workspace/file.txt)
    // DB path is usually relative to project root (e.g., /file.txt)
    let dbPath = rawEventPath;
    if (dbPath.startsWith("/workspace")) {
      dbPath = dbPath.substring("/workspace".length); // Remove leading "/workspace"
      if (dbPath === "") {
        // If path was exactly "/workspace"
        dbPath = "/"; // Represent workspace root as "/" for DB
      }
    }
    // Ensure path starts with a single slash if it's not the root itself
    if (dbPath !== "/" && !dbPath.startsWith("/")) {
      dbPath = "/" + dbPath;
    }
    console.log(`[API Internal] Watcher path: "${rawEventPath}", 
        Normalized DB path: "${dbPath}"`);

    // --- 3. Resolve Full Container ID and Project ID ---
    const fullContainerId = await findFullContainerId(shortContainerId);

    if (!fullContainerId) {
      console.error(
        `[API Internal] Full container ID not found for short ID: ${shortContainerId}. 
            Cannot process event for path: ${dbPath}.`
      );
      // 204 No Content: Request processed, nothing to return, watcher shouldn't retry.
      return res.status(204).send();
    }

    try {
      const containerRecord = await prisma.container.findUnique({
        where: { id: fullContainerId },
        select: { projectId: true },
      });

      if (!containerRecord || !containerRecord.projectId) {
        console.error(
          `[API Internal] Container DB record or 
                projectId not found for full ID: ${fullContainerId}. 
                Cannot process event for path: ${dbPath}.`
        );
        // 404 if container record is missing, as it's essential for project context
        return res
          .status(404)
          .send("Container record or associated project not found in DB");
      }
      const projectId = containerRecord.projectId;
      let fileSystemNodeForBroadcast: FileSystemNode | null = null; // For 'create' event broadcast

      // --- 4. Process Event Based on Type (create, delete, modify) ---
      if (event === "create") {
        const name = path.basename(dbPath); // Get filename or directory name
        let parentDbPath = path.dirname(dbPath).replace(/\\/g, "/");
        // Get parent path, normalize slashes
        if (parentDbPath === ".") {
          // `dirname` of a root file (e.g., "/file.txt") is "."
          parentDbPath = "/"; // Root parent path is '/'
        }

        const isDirectory = type === "directory";
        let parentId: string | null = null;

        // Find parentId from DB if not a root-level item
        if (parentDbPath !== "/") {
          const parentNode = await prisma.file.findUnique({
            where: { projectId_path: { projectId, path: parentDbPath } },
            select: { id: true, isDirectory: true },
          });
          if (parentNode && parentNode.isDirectory) {
            parentId = parentNode.id;
          } else {
            console.warn(
              `[API Internal] Parent node at DB path "${parentDbPath}" 
                        not found or not a directory for creating "${dbPath}". 
                        Will attempt to link to project root if applicable.`
            );
            // Fallback: check for a conventional project root node
            // if specific parent isn't found.
            // This assumes a File record with path: "/"
            // might represent the direct project root.
            const projectRootNode = await prisma.file.findFirst({
              where: { projectId, path: "/", parentId: null },
            });
            if (projectRootNode) parentId = projectRootNode.id;
          }
        } else {
          // Item is directly under the logical root '/'.
          // Its parentId might be null or the ID of a specific "/" root File record.
          const projectRootNode = await prisma.file.findFirst({
            where: { projectId, path: "/", parentId: null },
          });
          if (projectRootNode) parentId = projectRootNode.id;
        }

        // Check if node already exists (e.g., due to rapid events or watcher nuances)
        const existingNode = await prisma.file.findUnique({
          where: { projectId_path: { projectId, path: dbPath } },
        });

        if (existingNode) {
          console.warn(
            `[API Internal] Node ${dbPath} (event: create) 
                    reported by watcher already exists in DB. 
                    Updating timestamp and type.`
          );
          const updatedNode = await prisma.file.update({
            where: { id: existingNode.id },
            data: {
              updatedAt: new Date(),
              content: isDirectory
                ? null
                : existingNode.isDirectory !== isDirectory
                  ? null
                  : undefined,
              // Reset content if type changed or to refresh
              isDirectory: isDirectory, // Ensure type is correct
            },
          });
          fileSystemNodeForBroadcast = {
            ...updatedNode,
            createdAt: updatedNode.createdAt.toISOString(),
            updatedAt: updatedNode.updatedAt.toISOString(),
            content: updatedNode.content ?? undefined,
          };
        } else {
          // Create new file/directory record in DB
          const newNode = await prisma.file.create({
            data: {
              name,
              path: dbPath,
              isDirectory,
              projectId,
              parentId,
              content: isDirectory ? null : null,
              // New files start with null content (to be fetched on demand)
            },
          });
          console.log(`[API Internal] Created DB record for ${dbPath} 
                    (ID: ${newNode.id})`);
          fileSystemNodeForBroadcast = {
            ...newNode,
            createdAt: newNode.createdAt.toISOString(),
            updatedAt: newNode.updatedAt.toISOString(),
            content: newNode.content ?? undefined,
          };
        }
      } else if (event === "delete") {
        const nodeToDelete = await prisma.file.findUnique({
          where: { projectId_path: { projectId, path: dbPath } },
          select: { id: true, isDirectory: true },
        });

        if (nodeToDelete) {
          const idsToDelete: string[] = [nodeToDelete.id];
          // If it's a directory, find all descendants to delete them too
          if (nodeToDelete.isDirectory) {
            const queue = [nodeToDelete.id];
            while (queue.length > 0) {
              const currentParentId = queue.shift()!;
              // Non-null assertion as queue is controlled
              const children = await prisma.file.findMany({
                where: { parentId: currentParentId },
                select: { id: true, isDirectory: true },
              });
              children.forEach(
                (child: { id: string; isDirectory: boolean }) => {
                  idsToDelete.push(child.id);
                  if (child.isDirectory) {
                    queue.push(child.id);
                  }
                }
              );
            }
          }
          const deleteResult = await prisma.file.deleteMany({
            where: { id: { in: idsToDelete } },
          });
          console.log(`[API Internal] Deleted ${deleteResult.count} 
                    DB record(s) for path ${dbPath} 
                    and its children.`);
        } else {
          console.warn(`[API Internal] Node ${dbPath} not found in DB 
                    for delete event. No action taken.`);
        }
      } else if (event === "modify") {
        const nodeToUpdate = await prisma.file.findUnique({
          where: { projectId_path: { projectId, path: dbPath } },
          select: { id: true, isDirectory: true },
        });

        if (nodeToUpdate) {
          if (nodeToUpdate.isDirectory) {
            // For directories, just update the timestamp
            await prisma.file.update({
              where: { id: nodeToUpdate.id },
              data: { updatedAt: new Date() },
            });
          } else {
            // For files, update timestamp AND set content to null to trigger editor reload
            await prisma.file.update({
              where: { id: nodeToUpdate.id },
              data: {
                updatedAt: new Date(),
                content: null, // Signal that content is stale and needs refetching
              },
            });
          }
          console.log(`[API Internal] Updated timestamp 
                    (and nulled content for files) for modified item: ${dbPath}`);
        } else {
          console.warn(`[API Internal] Node ${dbPath} not found for modify event. 
                    It might be a new file modified quickly  `);
          // Optionally, could treat as 'create' if missing, but 'modify' implies existence.
        }
      } else {
        console.warn(
          `[API Internal] Received unhandled event type: "${event}" 
                for path ${dbPath}`
        );
      }

      // --- 5. Broadcast Event to Clients via Socket.IO ---
      // Only broadcast for known and processed event types
      if (
        io &&
        (event === "create" || event === "delete" || event === "modify")
      ) {
        io.to(fullContainerId).emit("fs-update", {
          containerId: fullContainerId,
          event, // 'create', 'delete', or 'modify'
          type, // 'file' or 'directory' (from original watcher event)
          path: dbPath, // Use the normalized dbPath
          // For 'create', send the newly created/updated node data
          ...(event === "create" &&
            fileSystemNodeForBroadcast && {
              node: fileSystemNodeForBroadcast,
            }),
        });
        console.log(`[API Internal] Broadcasted 'fs-update' 
                to room: ${fullContainerId} for event: ${event}, path: ${dbPath}`);
      }

      // --- 6. Send HTTP Response ---
      // 204 No Content: Successfully processed,
      // nothing to return to the HTTP client (watcher script)
      res.status(204).send();
    } catch (error: any) {
      console.error(
        `[API Internal Error] Failed to process FS event 
            for container ${shortContainerId} 
            (full: ${fullContainerId}), raw path ${rawEventPath} 
            (DB path ${dbPath}):`,
        error.message,
        error.stack
      );
      res.status(500).send("Internal Server Error");
    }
  }
);

// Export the router instance
export const internalFSRouter: Router = router;

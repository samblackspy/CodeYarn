// src/routes/fileHandlers.ts
import { Request, Response, NextFunction } from "express";
import prisma from "@codeyarn/db"; // Prisma client for database interactions
import path from "path"; // Node.js path module for path manipulation
import {
  getContainerSafely,
  execCmdInContainer,
} from "../services/dockerService"; // Centralized Docker helper functions

/**
 * GET /api/files/:fileId/details
 * Fetches and returns the metadata (details) of a specific file or folder node from the database.
 */
export async function getFileDetailsHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract fileId from request parameters.
  const { fileId } = req.params;

  // Validate the fileId.
  if (typeof fileId !== "string" || !fileId) {
    return res.status(400).json({ message: "Invalid file ID provided" });
  }
  console.log(`[API Files] Request received for details of node: ${fileId}`);

  try {
    // Fetch the file/folder record from the database, excluding its content.
    const fileRecord = await prisma.file.findUnique({
      where: { id: fileId },
      select: {
        // Specify only the fields needed for details.
        id: true,
        name: true,
        path: true,
        projectId: true,
        parentId: true,
        isDirectory: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // If no record is found, return a 404 error.
    if (!fileRecord) {
      return res.status(404).json({ message: "File/Folder node not found" });
    }

    console.log(`[API Files] Sending details for node: ${fileRecord.path}`);
    // Format date fields to ISO strings for the JSON response.
    const responseData = {
      ...fileRecord,
      createdAt: fileRecord.createdAt.toISOString(),
      updatedAt: fileRecord.updatedAt.toISOString(),
    };
    // Send the file/folder details as a JSON response.
    res.status(200).json(responseData);
  } catch (error: any) {
    // Handle any errors that occur during the process.
    console.error(
      `[API Error] Failed to get details for node ${fileId}:`,
      error
    );
    next(error); // Pass the error to the centralized error handler.
  }
}

/**
 * GET /api/files/:fileId/content
 * Fetches the content of a specific file.
 * If content is null in the database (stale or not yet fetched),
 * it attempts to fetch from the associated Docker container, update the DB, and then return the content.
 */
export async function getFileContentHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract fileId from request parameters.
  const { fileId } = req.params;

  // Validate the fileId.
  if (typeof fileId !== "string" || !fileId) {
    return res.status(400).json({ error: "Invalid file ID provided." });
  }
  console.log(`[API Files GET /content] Request for fileId: ${fileId}`);

  try {
    // Fetch the file record, including its content and necessary metadata.
    const fileRecord = await prisma.file.findUnique({
      where: { id: fileId },
      select: { content: true, isDirectory: true, path: true, projectId: true },
    });

    // If the file record is not found, return 404.
    if (!fileRecord) {
      return res.status(404).json({ error: "File not found in database." });
    }
    // If the record is a directory, return 400 as directories don't have content.
    if (fileRecord.isDirectory) {
      return res
        .status(400)
        .json({ error: "Cannot get content of a directory." });
    }

    let fileContent: string | null = fileRecord.content;

    // If content is null in DB, attempt to fetch from the container.
    if (fileContent === null) {
      console.log(
        `[API Files GET /content] DB content for path "${fileRecord.path}" (ID: ${fileId}) is null. Attempting to fetch from container.`
      );
      // Find the project to get the associated container ID.
      const project = await prisma.project.findUnique({
        where: { id: fileRecord.projectId },
        select: { containerId: true },
      });

      // If project and its container ID exist.
      if (project?.containerId) {
        const container = await getContainerSafely(project.containerId); // Get Docker container instance.

        if (container) {
          // If container instance is retrieved successfully.
          try {
            // Normalize the file path to be absolute within the container's /workspace.
            let pathInContainer = fileRecord.path;
            if (!pathInContainer.startsWith("/workspace/")) {
              pathInContainer = path.posix.join(
                "/workspace",
                pathInContainer.replace(/^\//, "")
              );
            }
            pathInContainer = path.posix.normalize(pathInContainer);

            console.log(
              `[API Files GET /content] Fetching content from container ${project.containerId} for path ${pathInContainer}`
            );
            // Execute 'cat' command in container to get file content.
            const execResult = await execCmdInContainer(
              container,
              ["cat", pathInContainer],
              "/"
            ); // Working dir as root for absolute path.

            if (execResult.success) {
              fileContent = execResult.stdout;
              console.log(
                `[API Files GET /content] Successfully fetched content for "${pathInContainer}" from container. Length: ${fileContent.length}`
              );
              // Update the database with the fetched content and a new timestamp.
              await prisma.file.update({
                where: { id: fileId },
                data: { content: fileContent, updatedAt: new Date() },
              });
            } else {
              // If 'cat' command fails, log error and set content to empty.
              console.error(
                `[API Files GET /content] Failed to 'cat' file "${pathInContainer}" from container. Stderr: ${execResult.stderr}`
              );
              fileContent = ""; // Default to empty if fetching fails.
            }
          } catch (dockerError: any) {
            // Handle errors during Docker interaction.
            console.error(
              `[API Files GET /content] Docker error fetching content for "${fileRecord.path}" (container: ${project.containerId}):`,
              dockerError.message
            );
            fileContent = ""; // Default to empty on Docker error.
          }
        } else {
          // If container for the project is not found or accessible.
          console.warn(
            `[API Files GET /content] Container ${project.containerId} for project ${fileRecord.projectId} not found or not accessible to fetch content for "${fileRecord.path}".`
          );
          fileContent = ""; // Default to empty.
        }
      } else {
        // If the project has no associated container ID.
        console.warn(
          `[API Files GET /content] No active container for project ${fileRecord.projectId} to fetch content for "${fileRecord.path}".`
        );
        fileContent = ""; // Default to empty.
      }
    } else {
      // If content was already in the DB, log that cached content is being served.
      console.log(
        `[API Files GET /content] Serving cached content from DB for path "${fileRecord.path}" (ID: ${fileId})`
      );
    }

    // Set response header for plain text and send the content.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(200).send(fileContent || ""); // Ensure a string is always sent.
  } catch (error: any) {
    // Handle any other errors during the process.
    console.error(
      `[API Error GET /content] Failed for fileId ${fileId}:`,
      error
    );
    next(error); // Pass to the centralized error handler.
  }
}

/**
 * PUT /api/files/:fileId/content
 * Updates the content of a specific file in the database
 * and attempts to sync this change to the running Docker container.
 */
export async function updateFileContentHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract fileId from parameters and newContent from the request body.
  const { fileId } = req.params;
  const newContent = req.body; // Assumes express.text() middleware is used.

  // Validate inputs.
  if (typeof fileId !== "string" || !fileId) {
    return res.status(400).json({ error: "Invalid file ID provided." });
  }
  if (typeof newContent !== "string") {
    // Content should be a string.
    return res
      .status(400)
      .json({
        error:
          "Invalid or missing file content in request body (expecting raw text).",
      });
  }
  console.log(
    `[API Files PUT /content] Request to update fileId: ${fileId}. Content length: ${newContent.length}`
  );

  try {
    // Fetch file record metadata to validate and get path/projectId.
    const fileRecord = await prisma.file.findUnique({
      where: { id: fileId },
      select: { path: true, isDirectory: true, projectId: true },
    });

    // Handle if file record not found or if it's a directory.
    if (!fileRecord) {
      return res.status(404).json({ error: "File not found in database." });
    }
    if (fileRecord.isDirectory) {
      return res
        .status(400)
        .json({ error: "Cannot set content of a directory." });
    }

    // --- 1. Update the content in the database ---
    const updatedFileInDb = await prisma.file.update({
      where: { id: fileId },
      data: { content: newContent, updatedAt: new Date() }, // Set new content and update timestamp.
      select: { id: true, path: true, updatedAt: true, projectId: true }, // Select fields for response and further logic.
    });
    console.log(
      `[API Files PUT /content] Updated content in DB for path: ${updatedFileInDb.path}`
    );

    // --- 2. Sync the content to the running container (if any) ---
    const project = await prisma.project.findUnique({
      where: { id: updatedFileInDb.projectId },
      select: { containerId: true }, // Get container ID associated with the project.
    });

    if (project?.containerId) {
      // If project has an associated container.
      const container = await getContainerSafely(project.containerId); // Get Docker container instance.

      if (container) {
        // If container instance is retrieved.
        try {
          // Normalize file path to be absolute within /workspace.
          let filePathInContainer = updatedFileInDb.path;
          if (!filePathInContainer.startsWith("/workspace/")) {
            filePathInContainer = path.posix.join(
              "/workspace",
              filePathInContainer.replace(/^\//, "")
            );
          }
          filePathInContainer = path.posix.normalize(filePathInContainer);

          // Escape single quotes in the content for safe shell execution.
          const escapedContent = newContent.replace(/'/g, "'\\''");
          // Prepare command to ensure directory exists and then write file using printf.
          const dirnameForCmd = path.posix.dirname(filePathInContainer);
          const cmdForContainer = `mkdir -p '${dirnameForCmd}' && printf '%s' '${escapedContent}' > '${filePathInContainer}'`;

          console.log(
            `[API Files PUT /content] Executing sync command in container ${project.containerId} for path ${filePathInContainer}`
          );
          // Execute the command in the container.
          const execResult = await execCmdInContainer(
            container,
            ["sh", "-c", cmdForContainer],
            "/"
          ); // Working dir as root.

          if (execResult.success) {
            console.log(
              `[API Files PUT /content] Successfully synced file ${filePathInContainer} to container.`
            );
          } else {
            // Log error if syncing to container fails. DB update was still successful.
            console.error(
              `[API Files PUT /content] Failed to sync file ${filePathInContainer} to container. Stderr: ${execResult.stderr}`
            );
          }
        } catch (dockerError: any) {
          // Handle errors during Docker interaction.
          console.error(
            `[API Files PUT /content] Docker error syncing to container ${project.containerId} for path ${fileRecord.path}:`,
            dockerError.message
          );
        }
      } else {
        // If container instance could not be retrieved.
        console.warn(
          `[API Files PUT /content] Container ${project.containerId} not found or not accessible for project ${updatedFileInDb.projectId}. Skipping file sync for ${updatedFileInDb.path}.`
        );
      }
    } else {
      // If project has no associated container.
      console.log(
        `[API Files PUT /content] No active container for project ${updatedFileInDb.projectId}. Skipping file sync for ${updatedFileInDb.path}.`
      );
    }

    // --- 3. Respond to Client ---
    // Response indicates success of DB update primarily.
    res.status(200).json({
      message: "File content updated successfully in database.",
      fileId: updatedFileInDb.id,
      path: updatedFileInDb.path,
      updatedAt: updatedFileInDb.updatedAt.toISOString(),
    });
  } catch (error: any) {
    // Handle any other errors during the process.
    console.error(
      `[API Error PUT /content] Failed for fileId ${fileId}:`,
      error
    );
    next(error); // Pass to the centralized error handler.
  }
}

/**
 * POST /api/files
 * Creates a new file or directory in the database and attempts to create it in the associated Docker container.
 */
export async function createFileOrDirectoryHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract necessary data from the request body.
  const { projectId, parentId, name, isDirectory } = req.body;

  // --- 1. Input Validation ---
  if (!projectId || typeof projectId !== "string") {
    return res.status(400).json({ message: "Missing or invalid projectId" });
  }
  if (parentId && typeof parentId !== "string") {
    // parentId is optional.
    return res.status(400).json({ message: "Invalid parentId" });
  }
  if (
    !name ||
    typeof name !== "string" ||
    name.includes("/") ||
    name.trim() === ""
  ) {
    // Name validation.
    return res.status(400).json({ message: "Invalid name" });
  }
  if (typeof isDirectory !== "boolean") {
    // isDirectory flag must be a boolean.
    return res
      .status(400)
      .json({ message: "Missing or invalid isDirectory flag" });
  }

  console.log(
    `[API Files] Request to create ${isDirectory ? "directory" : "file"} "${name}" in project ${projectId} under parent ${parentId || "root"}`
  );

  try {
    // --- 2. Determine Parent Path for the new node ---
    let parentPath = "/workspace"; // Default to /workspace if no parentId (project root in container terms).
    if (parentId) {
      // If parentId is provided, fetch the parent node to determine its path.
      const parentNode = await prisma.file.findUnique({
        where: { id: parentId, projectId: projectId }, // Ensure parent belongs to the same project.
      });
      if (!parentNode) {
        return res.status(404).json({ message: "Parent directory not found" });
      }
      if (!parentNode.isDirectory) {
        // Parent must be a directory.
        return res.status(400).json({ message: "Parent is not a directory" });
      }
      parentPath = parentNode.path; // Use the parent's path.
    }
    // Construct the full path for the new file/directory.
    const newPath = path.posix.join(parentPath, name).replace(/\\/g, "/"); // Use posix.join and normalize slashes.

    // --- 3. Check if a node with the same path already exists in the project ---
    const existing = await prisma.file.findUnique({
      where: { projectId_path: { projectId, path: newPath } }, // Use composite unique key.
    });
    if (existing) {
      // If path is already taken, return a conflict error.
      return res
        .status(409)
        .json({
          message: `An item named "${name}" already exists at this location.`,
        });
    }

    // --- 4. Create the File/Directory Record in the Database ---
    const newNode = await prisma.file.create({
      data: {
        name: name.trim(),
        path: newPath,
        isDirectory: isDirectory,
        projectId: projectId,
        parentId: parentId || null, // Set parentId or null if root level.
        content: isDirectory ? null : "", // Initialize files with empty content, directories with null.
      },
    });
    console.log(
      `[API Files] Created DB record for ${newNode.path} (ID: ${newNode.id})`
    );

    // --- 5. Attempt to Create the File/Directory in the Docker Container ---
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { containerId: true }, // Get the project's associated container ID.
    });

    if (project?.containerId) {
      // If the project has a linked container.
      const container = await getContainerSafely(project.containerId); // Get the Docker container instance.

      if (container) {
        // If the container instance is retrieved.
        const inspectData = await container.inspect();
        if (inspectData.State.Running) {
          // Only proceed if the container is running.
          let cmdInContainer: string[];
          if (isDirectory) {
            // Command to create a directory (and parent directories if they don't exist).
            cmdInContainer = ["mkdir", "-p", newPath];
          } else {
            // Command to ensure parent directory exists and then create an empty file.
            cmdInContainer = [
              "sh",
              "-c",
              `mkdir -p "$(dirname "${newPath}")" && touch "${newPath}"`,
            ];
          }
          // Execute the command in the container.
          const { success } = await execCmdInContainer(
            container,
            cmdInContainer,
            "/"
          ); // Working dir as root for absolute paths.
          if (!success) {
            // Log a warning if container creation fails; DB record was still created.
            console.warn(
              `[API Files] Failed to create ${newPath} in container ${project.containerId}, but DB record created.`
            );
          } else {
            console.log(
              `[API Files] Successfully created ${newPath} in container ${project.containerId}`
            );
          }
        } else {
          console.warn(
            `[API Files] Container ${project.containerId} not running, skipping container creation of ${newPath}.`
          );
        }
      } else {
        console.warn(
          `[API Files] Container ${project.containerId} for project ${projectId} not found or not accessible. Skipping container creation of ${newPath}.`
        );
      }
    }

    // --- 6. Respond with the Created Node Data ---
    const responseData = {
      ...newNode,
      createdAt: newNode.createdAt.toISOString(),
      updatedAt: newNode.updatedAt.toISOString(),
    };
    res.status(201).json(responseData); // 201 Created status.
  } catch (error: any) {
    // Handle any errors during the process.
    console.error(`[API Error] Failed to create file/folder "${name}":`, error);
    // Specifically handle Prisma unique constraint violation errors for paths.
    if (
      error.code === "P2002" &&
      error.meta?.target?.includes("projectId_path")
    ) {
      return res
        .status(409)
        .json({
          message: `An item named "${name}" already exists at this location.`,
        });
    }
    next(error); // Pass other errors to the centralized error handler.
  }
}

/**
 * DELETE /api/files/:fileId
 * Deletes a file or directory (recursively if it's a directory) from the database
 * and attempts to delete it from the associated Docker container.
 */
export async function deleteFileOrDirectoryHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract fileId from request parameters.
  const { fileId } = req.params;

  // Validate the fileId.
  if (typeof fileId !== "string" || !fileId) {
    return res.status(400).json({ message: "Invalid file ID provided" });
  }
  console.log(`[API Files] Request to delete node: ${fileId}`);

  try {
    // --- 1. Perform Database Deletion within a Transaction ---
    const deletedNode = await prisma.$transaction(async (tx) => {
      // Find the node to be deleted.
      const nodeToDelete = await tx.file.findUnique({
        where: { id: fileId },
        select: { id: true, path: true, projectId: true, isDirectory: true },
      });
      // If node not found, throw an error to rollback transaction and return 404 later.
      if (!nodeToDelete) {
        throw new Error("NotFound"); // Custom error message to be caught below.
      }

      // Prepare a list of IDs to delete, starting with the node itself.
      const idsToDelete: string[] = [nodeToDelete.id];
      // If it's a directory, find all its descendants recursively.
      if (nodeToDelete.isDirectory) {
        const queue = [nodeToDelete.id]; // Queue for BFS-like traversal.
        while (queue.length > 0) {
          const currentParentId = queue.shift()!; // Get next parentId from queue.
          const children = await tx.file.findMany({
            where: { parentId: currentParentId },
            select: { id: true, isDirectory: true },
          });
          // Add children to deletion list and queue directories for further traversal.
          children.forEach((child) => {
            idsToDelete.push(child.id);
            if (child.isDirectory) {
              queue.push(child.id);
            }
          });
        }
        console.log(
          `[API Files] Found ${idsToDelete.length - 1} descendants for directory ${nodeToDelete.path}`
        );
      }

      // Delete all identified nodes (the target node and its descendants) from the database.
      const deleteResult = await tx.file.deleteMany({
        where: { id: { in: idsToDelete } },
      });
      console.log(
        `[API Files] Deleted ${deleteResult.count} record(s) from DB for path ${nodeToDelete.path}`
      );

      return nodeToDelete; // Return info about the primarily deleted node.
    });

    // --- 2. Attempt to Delete from Docker Container ---
    // Get the project to find the associated container ID.
    const project = await prisma.project.findUnique({
      where: { id: deletedNode.projectId }, // Use projectId from the deleted node.
      select: { containerId: true },
    });

    if (project?.containerId) {
      // If the project has a linked container.
      const container = await getContainerSafely(project.containerId); // Get Docker container instance.

      if (container) {
        // If container instance retrieved.
        const inspectData = await container.inspect();
        if (inspectData.State.Running) {
          // Only proceed if container is running.
          // Normalize path for container (ensure it's absolute from /workspace).
          const filePathInContainer = deletedNode.path.startsWith("/workspace/")
            ? deletedNode.path
            : deletedNode.path.startsWith("/")
              ? `/workspace${deletedNode.path}`
              : `/workspace/${deletedNode.path}`;
          console.log(
            `[API Files] Normalized deletion path from ${deletedNode.path} to ${filePathInContainer}`
          );

          // Command to recursively and forcefully delete the file/directory.
          const cmd = ["rm", "-rf", filePathInContainer];
          // Execute the command in the container.
          const { success } = await execCmdInContainer(container, cmd, "/"); // Working dir as root.
          if (!success) {
            // Log warning if container deletion fails; DB records were still deleted.
            console.warn(
              `[API Files] Failed to delete ${deletedNode.path} in container ${project.containerId}, but DB record(s) deleted.`
            );
          } else {
            console.log(
              `[API Files] Successfully deleted ${deletedNode.path} in container ${project.containerId}`
            );
          }
        } else {
          console.warn(
            `[API Files] Container ${project.containerId} not running, skipping container deletion of ${deletedNode.path}.`
          );
        }
      } else {
        console.warn(
          `[API Files] Container ${project.containerId} for project ${deletedNode.projectId} not found or not accessible. Skipping container deletion of ${deletedNode.path}.`
        );
      }
    }

    // --- 3. Respond to Client ---
    // 200 OK with a message, or 204 No Content if preferred for DELETE.
    res.status(200).json({ message: "Item deleted successfully" });
  } catch (error: any) {
    // Handle custom 'NotFound' error thrown from transaction.
    if (error.message === "NotFound") {
      return res.status(404).json({ message: "File/Folder not found" });
    }
    // Handle any other errors.
    console.error(`[API Error] Failed to delete node ${fileId}:`, error);
    next(error); // Pass to centralized error handler.
  }
}

/**
 * PUT /api/files/:fileId/rename
 * Renames a file or directory in the database (and updates paths of descendants if it's a directory)
 * and attempts to rename it in the associated Docker container.
 */
export async function renameFileOrDirectoryHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract fileId from parameters and newName from request body.
  const { fileId } = req.params;
  const { newName } = req.body;

  // --- 1. Input Validation ---
  if (typeof fileId !== "string" || !fileId) {
    return res.status(400).json({ message: "Invalid file ID" });
  }
  if (
    !newName ||
    typeof newName !== "string" ||
    newName.includes("/") ||
    newName.includes("\\") ||
    newName.trim() === ""
  ) {
    return res.status(400).json({ message: "Invalid new name" });
  }

  const trimmedNewName = newName.trim(); // Use trimmed name.
  console.log(
    `[API Files] Request to rename node ${fileId} to "${trimmedNewName}"`
  );

  try {
    // --- 2. Perform Database Rename and Path Updates within a Transaction ---
    const { updatedNodeResult, originalPath, originalProjectId } =
      await prisma.$transaction(async (tx) => {
        // Find the node to be renamed.
        const nodeToRename = await tx.file.findUnique({
          where: { id: fileId },
          select: {
            id: true,
            name: true,
            path: true,
            projectId: true,
            parentId: true,
            isDirectory: true,
          },
        });
        // Handle if node not found or if new name is same as old.
        if (!nodeToRename) throw new Error("NotFound");
        if (nodeToRename.name === trimmedNewName) throw new Error("SameName");

        const currentOriginalPath = nodeToRename.path; // Original path for reference.
        const currentOriginalProjectId = nodeToRename.projectId; // Project ID for checks.

        // Determine the new path based on the parent's path and the new name.
        const parentDir = path.posix
          .dirname(currentOriginalPath)
          .replace(/\\/g, "/");
        const newPath = path.posix
          .join(parentDir, trimmedNewName)
          .replace(/\\/g, "/");

        // Check if a node with the new path already exists in the same project.
        const existing = await tx.file.findUnique({
          where: {
            projectId_path: {
              projectId: currentOriginalProjectId,
              path: newPath,
            },
          },
        });
        if (existing) throw new Error("Conflict"); // Path conflict.

        // If renaming a directory, prepare to update paths of all its descendants.
        const descendantsToUpdate: { id: string; path: string }[] = [];
        if (nodeToRename.isDirectory) {
          const queue: { id: string; path: string }[] = [
            { id: nodeToRename.id, path: nodeToRename.path },
          ];
          while (queue.length > 0) {
            const current = queue.shift()!;
            const children = await tx.file.findMany({
              where: { parentId: current.id },
              select: { id: true, path: true, isDirectory: true },
            });
            children.forEach((child) => {
              descendantsToUpdate.push({ id: child.id, path: child.path });
              if (child.isDirectory)
                queue.push({ id: child.id, path: child.path });
            });
          }
          console.log(
            `[API Files] Found ${descendantsToUpdate.length} descendants to update path for rename.`
          );
        }

        // Define old and new path prefixes for updating descendant paths.
        const oldPathPrefix =
          currentOriginalPath + (nodeToRename.isDirectory ? "/" : "");
        const newPathPrefix = newPath + (nodeToRename.isDirectory ? "/" : "");

        // Update paths for all descendants.
        for (const descendant of descendantsToUpdate) {
          if (descendant.path.startsWith(oldPathPrefix)) {
            // Construct new path by replacing the old prefix with the new prefix.
            const updatedDescendantPath =
              newPathPrefix + descendant.path.substring(oldPathPrefix.length);
            await tx.file.update({
              where: { id: descendant.id },
              data: { path: updatedDescendantPath },
            });
          } else if (
            descendant.path === currentOriginalPath &&
            !nodeToRename.isDirectory
          ) {
            // This condition is mainly for completeness; the main node update handles the file itself.
          } else {
            // Log a warning if a descendant's path doesn't match the expected prefix.
            console.warn(
              `[API Files] Descendant path ${descendant.path} did not correctly match prefix ${oldPathPrefix} during rename for ${nodeToRename.name} (isDirectory: ${nodeToRename.isDirectory}). This might indicate an issue in path logic.`
            );
          }
        }

        // Update the target node itself (its name and path).
        const finalUpdatedNode = await tx.file.update({
          where: { id: fileId },
          data: { name: trimmedNewName, path: newPath },
          select: {
            id: true,
            name: true,
            path: true,
            projectId: true,
            parentId: true,
            isDirectory: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        // Return necessary info from the transaction.
        return {
          updatedNodeResult: finalUpdatedNode,
          originalPath: currentOriginalPath,
          originalProjectId: currentOriginalProjectId,
        };
      }); // End Transaction

    console.log(
      `[API Files] Renamed node ${fileId} to "${trimmedNewName}" in DB.`
    );

    // --- 3. Attempt to Rename in Docker Container ---
    const project = await prisma.project.findUnique({
      where: { id: originalProjectId }, // Use projectId from transaction result.
      select: { containerId: true },
    });

    if (project?.containerId) {
      // If project has a linked container.
      const container = await getContainerSafely(project.containerId); // Get Docker container instance.

      if (container) {
        // If container instance retrieved.
        const inspectData = await container.inspect();
        if (inspectData.State.Running) {
          // Only proceed if container is running.
          const oldPathForContainer = originalPath; // Original path from transaction.
          const newPathForContainer = updatedNodeResult.path; // New path from transaction.

          // Ensure paths are absolute within /workspace for the 'mv' command.
          const finalOldPath = oldPathForContainer.startsWith("/workspace/")
            ? oldPathForContainer
            : path.posix.join(
                "/workspace",
                oldPathForContainer.replace(/^\//, "")
              );
          const finalNewPath = newPathForContainer.startsWith("/workspace/")
            ? newPathForContainer
            : path.posix.join(
                "/workspace",
                newPathForContainer.replace(/^\//, "")
              );

          // Command to move/rename the file/directory in the container.
          // -T treats DEST as a normal file if SRC is a file, preventing mv into a new dir named DEST if DEST exists.
          const cmd = ["mv", "-T", finalOldPath, finalNewPath];
          // Execute command.
          const { success, stderr } = await execCmdInContainer(
            container,
            cmd,
            "/"
          ); // Working dir as root.
          if (!success) {
            // Log warning if container rename fails; DB records were still updated.
            console.warn(
              `[API Files] Failed to rename ${finalOldPath} to ${finalNewPath} in container ${project.containerId}. Error: ${stderr}. DB record(s) updated.`
            );
          } else {
            console.log(
              `[API Files] Successfully renamed ${finalOldPath} to ${finalNewPath} in container ${project.containerId}`
            );
          }
        } else {
          console.warn(
            `[API Files] Container ${project.containerId} not running, skipping container rename.`
          );
        }
      } else {
        console.warn(
          `[API Files] Container ${project.containerId} for project ${originalProjectId} not found or not accessible. Skipping rename of ${originalPath}.`
        );
      }
    }

    // --- 4. Respond with the Updated Node Data ---
    const responseData = {
      ...updatedNodeResult, // Use the fully updated node data from the transaction.
      createdAt: updatedNodeResult.createdAt.toISOString(),
      updatedAt: updatedNodeResult.updatedAt.toISOString(),
    };
    res.status(200).json(responseData);
  } catch (error: any) {
    // Handle any errors, including custom errors thrown from the transaction.
    console.error(
      `[API Error] Failed to rename node ${fileId} to "${trimmedNewName}":`,
      error
    );
    if (error.message === "NotFound")
      return res.status(404).json({ message: "File/Folder not found" });
    if (error.message === "SameName")
      return res
        .status(400)
        .json({ message: "New name is the same as the old name" });
    // Handle Prisma unique constraint or custom 'Conflict' error.
    if (
      error.message === "Conflict" ||
      (error.code === "P2002" && error.meta?.target?.includes("projectId_path"))
    ) {
      return res
        .status(409)
        .json({
          message: `An item named "${trimmedNewName}" already exists at this location.`,
        });
    }
    next(error); // Pass other errors to the centralized error handler.
  }
}

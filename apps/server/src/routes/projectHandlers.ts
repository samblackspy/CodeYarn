// src/routes/projectHandlers.ts
import { Request, Response, NextFunction } from "express";
import prisma from "@codeyarn/db";
import { buildTreeFromFlatList, PrismaFileNode } from "../lib/utils";
import { getContainerSafely } from "../services/dockerService";

/**
 * Handles fetching and returning the file tree structure for a given project.
 */
export async function getProjectFilesHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract projectId from request parameters.
  const { projectId } = req.params;

  // Validate projectId.
  if (typeof projectId !== "string" || !projectId) {
    return res.status(400).json({ message: "Invalid project ID provided" });
  }
  console.log(
    `[API Projects] Request received for file tree of project: ${projectId}`
  );

  try {
    // Verify that the project exists in the database.
    const projectExists = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true }, // Select minimal fields to check existence.
    });

    // If project doesn't exist, return a 404 error.
    if (!projectExists) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Fetch all file and folder nodes associated with the project.
    const fileNodesFromDb = await prisma.file.findMany({
      where: { projectId: projectId },
      select: {
        // Select fields necessary for building the file tree.
        id: true,
        name: true,
        path: true,
        projectId: true,
        parentId: true,
        isDirectory: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { path: "asc" }, // Order by path for consistent tree structure.
    });

    // Build the hierarchical file tree from the flat list of nodes.
    const fileTree = buildTreeFromFlatList(
      fileNodesFromDb as PrismaFileNode[], // Assert type for the helper function.
      projectId // Pass projectId to the tree builder.
    );

    console.log(`[API Projects] Sending file tree for project: ${projectId}`);
    // Respond with the project ID and the constructed file structure.
    res.status(200).json({
      containerId: null, // Not directly relevant for this DB-based file tree.
      projectId: projectId,
      fileStructure: fileTree,
    });
  } catch (error: any) {
    // Handle any errors during the process.
    console.error(
      `[API Error] Failed to get file tree for project ${projectId}:`,
      error
    );
    next(error); // Pass error to the centralized error handler.
  }
}

/**
 * Handles the creation of a new project.
 */
export async function createProjectHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract project details from the request body.
  const { name, templateId, description } = req.body;
  // Placeholder for owner ID; replace with actual authenticated user ID in a real app.
  const ownerId = "clerk-user-placeholder";

  // Validate required fields.
  if (!name || typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ message: "Missing or invalid project name" });
  }
  if (!templateId || typeof templateId !== "string") {
    return res.status(400).json({ message: "Missing or invalid templateId" });
  }
  // Validate optional description.
  if (description && typeof description !== "string") {
    return res.status(400).json({ message: "Invalid description format" });
  }

  console.log(
    `[API Projects] Request to create project "${name}" with template ${templateId}`
  );

  try {
    // Create the new project in the database.
    const newProject = await prisma.project.create({
      data: {
        name: name.trim(),
        templateId: templateId,
        ownerId: ownerId,
        description: description?.trim() || null, // Use trimmed description or null.
        // containerId will be null initially.
      },
    });
    console.log(`[API Projects] Created project ${newProject.id}`);

    // Format date fields to ISO strings for the JSON response.
    const responseData = {
      ...newProject,
      createdAt: newProject.createdAt.toISOString(),
      updatedAt: newProject.updatedAt.toISOString(),
      lastAccessedAt: newProject.lastAccessedAt?.toISOString() ?? null,
    };
    // Respond with 201 Created status and the new project data.
    res.status(201).json(responseData);
  } catch (error: any) {
    // Handle errors, such as a foreign key constraint violation if templateId is invalid.
    console.error(`[API Error] Failed to create project "${name}":`, error);
    if (error.code === "P2003") {
      // Prisma error code for foreign key constraint failed.
      return res
        .status(400)
        .json({ message: `Invalid templateId: ${templateId}` });
    }
    next(error); // Pass other errors to the centralized error handler.
  }
}

/**
 * Handles listing all projects for a given owner.
 */
export async function listProjectsHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Placeholder for owner ID; replace with actual authenticated user ID.
  const ownerId = "clerk-user-placeholder";
  console.log(`[API Projects] Request to list projects for owner ${ownerId}`);

  try {
    // Fetch all projects belonging to the specified owner.
    const projects = await prisma.project.findMany({
      where: { ownerId: ownerId },
      orderBy: { updatedAt: "desc" }, // Order by most recently updated.
    });

    // Format date fields in the response data.
    const responseData = projects.map(
      (p: {
        createdAt: { toISOString: () => any };
        updatedAt: { toISOString: () => any };
        lastAccessedAt: { toISOString: () => any };
      }) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        lastAccessedAt: p.lastAccessedAt?.toISOString() ?? null,
      })
    );
    // Respond with the list of projects.
    res.status(200).json(responseData);
  } catch (error: any) {
    // Handle any errors during the process.
    console.error(
      `[API Error] Failed to list projects for owner ${ownerId}:`,
      error
    );
    next(error); // Pass error to the centralized error handler.
  }
}

/**
 * Handles fetching the details of a specific project.
 */
export async function getProjectDetailsHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract projectId from request parameters.
  const { projectId } = req.params;
  // Validate projectId.
  if (typeof projectId !== "string" || !projectId)
    return res.status(400).json({ message: "Invalid project ID" });
  console.log(`[API Projects] Request to get details for project ${projectId}`);

  try {
    // Fetch the project details from the database.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    // If project is not found, return a 404 error.
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Format date fields in the response data.
    const responseData = {
      ...project,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      lastAccessedAt: project.lastAccessedAt?.toISOString() ?? null,
    };
    // Respond with the project details.
    res.status(200).json(responseData);
  } catch (error: any) {
    // Handle any errors during the process.
    console.error(`[API Error] Failed to get project ${projectId}:`, error);
    next(error); // Pass error to the centralized error handler.
  }
}

/**
 * Handles deleting a specific project and its associated Docker container.
 */
export async function deleteProjectHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract projectId from request parameters.
  const { projectId } = req.params;
  // Validate projectId.
  if (typeof projectId !== "string" || !projectId)
    return res.status(400).json({ message: "Invalid project ID" });
  console.log(`[API Projects] Request to delete project ${projectId}`);

  try {
    // Fetch the project to get its associated containerId (if any).
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { containerId: true }, // Only select the containerId.
    });

    // If project is not found, return a 404 error.
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // If the project has an associated container, attempt to remove it from Docker.
    if (project.containerId) {
      const containerId = project.containerId;
      console.log(
        `[API Projects] Attempting to stop/remove associated container ${containerId} for project ${projectId}`
      );
      try {
        // Safely get the Docker container instance.
        const container = await getContainerSafely(containerId);
        if (container) {
          // Force remove the container (stops it if running).
          await container.remove({ force: true });
          console.log(
            `[API Projects] Removed container ${containerId} from Docker.`
          );
        } else {
          // Log if the container was not found in Docker (might have been manually removed).
          console.log(
            `[API Projects] Associated container ${containerId} not found in Docker, skipping Docker removal.`
          );
        }
      } catch (dockerError: any) {
        // Log Docker errors but continue with DB deletion to ensure project record is removed.
        console.error(
          `[API Projects] Failed to remove container ${containerId} from Docker during project delete, continuing with DB delete:`,
          dockerError.message
        );
      }
    }

    // Delete the project record from the database.
    // Cascading deletes (for associated File and Container records) should be handled by Prisma schema relations.
    await prisma.project.delete({
      where: { id: projectId },
    });

    console.log(
      `[API Projects] Deleted project ${projectId} and associated data from DB.`
    );
    // Respond with 204 No Content on successful deletion.
    res.status(204).send();
  } catch (error: any) {
    // Handle any errors during the process.
    console.error(`[API Error] Failed to delete project ${projectId}:`, error);
    next(error); // Pass error to the centralized error handler.
  }
}

// src/routes/containerHandlers.ts
import { Request, Response, NextFunction } from "express";
import Docker from "dockerode";
import prisma from "@codeyarn/db";
import portfinder from "portfinder";
import { PassThrough } from "stream";
import {
  ContainerStatus,
  Container as SharedContainer,
} from "@codeyarn/shared-types";
import { populateWorkspaceAndCreateDbFilesImpl } from "./containerUtils";
import { docker } from "../dockerClient";
import { getContainerSafely } from "../services/dockerService";

//   a type for the global file watch map for getFileStatusHandler
declare global {
  var fileWatchMap: Map<string, number>;
}
if (!global.fileWatchMap) {
  global.fileWatchMap = new Map<string, number>();
}

export async function createOrRetrieveContainerHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { projectId, templateId } = req.body;

  // --- 1. Input Validation ---
  if (!projectId || typeof projectId !== "string") {
    return res.status(400).json({ message: "Missing or invalid projectId" });
  }
  if (!templateId || typeof templateId !== "string") {
    return res.status(400).json({ message: "Missing or invalid templateId" });
  }

  console.log(
    `[API Containers] Request: Project ${projectId}, Template ${templateId}`
  );
  let wasNewContainerActuallyCreated = false;
  let containerIdForCleanup: string | null = null; // For cleanup if errors occur after creation

  try {
    // --- 2. Fetch Project & Template Details ---
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, templateId: true, containerId: true },
    });

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    const template = await prisma.template.findUnique({
      where: { id: templateId },
      select: {
        id: true,
        name: true,
        dockerImage: true,
        sourceHostPath: true,
        startCommand: true,
        defaultPort: true,
      },
    });

    if (!template || !template.dockerImage) {
      return res
        .status(404)
        .json({ message: "Template not found or dockerImage not specified." });
    }
    if (!template.defaultPort) {
      return res
        .status(400)
        .json({ message: `Template ${templateId} is missing defaultPort.` });
    }
    console.log(`[API Containers] Using Template: ${template.name}, 
            Image: ${template.dockerImage}, 
            StartCmd: ${template.startCommand}, 
            Port: ${template.defaultPort}, 
            SourcePath: ${template.sourceHostPath}`);

    // --- 3. Check for Existing Container Record in DB ---
    let dbContainerRecord = await prisma.container.findUnique({
      where: { projectId: projectId }, // A project should only have one container
      select: {
        id: true,
        status: true,
        hostPort: true,
        internalPort: true,
        projectId: true,
        templateId: true,
        createdAt: true,
        startedAt: true,
        stoppedAt: true,
      },
    });

    let dockerContainerInstance: Docker.Container | null = null;
    let finalHostPortToUseInResponse: number | null =
      dbContainerRecord?.hostPort || null;

    // --- 4. Handle Existing Container Scenario ---
    if (dbContainerRecord && dbContainerRecord.id) {
      containerIdForCleanup = dbContainerRecord.id; // Mark for potential cleanup
      console.log(`[API Containers] Existing DB container 
                record found: ${dbContainerRecord.id}. 
                Verifying Docker state.`);
      dockerContainerInstance = await getContainerSafely(dbContainerRecord.id);

      if (dockerContainerInstance) {
        let inspectInfo = await dockerContainerInstance.inspect();
        // finalHostPortToUseInResponse already set from dbContainerRecord.hostPort

        // Handle template mismatch: recreate container
        if (templateId !== dbContainerRecord.templateId) {
          console.warn(`[API Containers] Template ID mismatch for project ${projectId}. 
                        Removing old container ${dbContainerRecord.id} to recreate with new template ${templateId}.`);
          await dockerContainerInstance
            .remove({ force: true })
            .catch((e) =>
              console.error(
                `[API Containers] Failed to remove container for template change: ${e.message}`
              )
            );
          await prisma.container.delete({
            where: { id: dbContainerRecord.id },
          });
          dbContainerRecord = null; // Force recreation path
          dockerContainerInstance = null; // Nullify instance
        } else if (!inspectInfo.State.Running) {
          // If container exists but is stopped, try to start it
          console.log(
            `[API Containers] Existing container ${dbContainerRecord.id} is stopped. Starting...`
          );
          try {
            await dockerContainerInstance.start();
            inspectInfo = await dockerContainerInstance.inspect(); // Re-inspect after start
            console.log(
              `[API Containers] Started existing container ${dbContainerRecord.id}.`
            );
            // Update DB if status or startedAt needs sync
            if (
              dbContainerRecord.status !== "RUNNING" ||
              !inspectInfo.State.StartedAt
            ) {
              dbContainerRecord = await prisma.container.update({
                where: { id: dbContainerRecord.id },
                data: {
                  status: "RUNNING",
                  startedAt: new Date(inspectInfo.State.StartedAt),
                },
                select: {
                  id: true,
                  status: true,
                  hostPort: true,
                  internalPort: true,
                  projectId: true,
                  templateId: true,
                  createdAt: true,
                  startedAt: true,
                  stoppedAt: true,
                },
              });
            }
          } catch (startError: any) {
            // If starting fails, remove and recreate
            console.error(`[API Containers] Failed to start existing container ${dbContainerRecord.id}: 
                            ${startError.message}. Removing & recreating.`);
            await dockerContainerInstance.remove({ force: true }).catch((e) =>
              console.error(`[API Containers] Cleanup failed for non-starting container 
                                    ${dockerContainerInstance?.id}: ${e.message}`)
            );
            await prisma.container.delete({
              where: { id: dbContainerRecord.id },
            });
            dbContainerRecord = null;
            dockerContainerInstance = null;
          }
        }
      } else {
        // DB record exists, but Docker container is gone; clean DB and recreate
        console.warn(`[API Containers] DB record for ${dbContainerRecord.id} exists, 
                    but Docker container not found. Cleaning DB, will recreate.`);
        await prisma.container.delete({ where: { id: dbContainerRecord.id } });
        dbContainerRecord = null;
      }
    }

    // --- 5. Create New Container if Needed ---
    if (!dbContainerRecord) {
      wasNewContainerActuallyCreated = true;
      console.log(
        `[API Containers] Creating new container for project ${projectId}.`
      );

      // Find an available host port
      let allocatedHostPort: number;
      try {
        portfinder.basePort = 32000; // Start searching for ports from 32000
        allocatedHostPort = await portfinder.getPortPromise();
        console.log(
          `[API Containers] Allocated hostPort via portfinder: ${allocatedHostPort}`
        );
      } catch (portError: any) {
        console.error(
          `[API Containers] Portfinder error for project ${projectId}:`,
          portError.message
        );
        return next(new Error("Could not allocate a free port."));
      }
      finalHostPortToUseInResponse = allocatedHostPort;

      // Ensure Docker volume exists for the project
      const volumeName = `codeyarn-vol-${projectId}`;
      try {
        await docker.createVolume({ Name: volumeName }); // Use central docker instance
      } catch (volumeError: any) {
        if (volumeError.statusCode !== 409) {
          // 409 means volume already exists, which is fine
          console.error(
            `[API Containers] Error creating volume ${volumeName}:`,
            volumeError.message
          );
          return next(
            new Error(`Volume creation failed: ${volumeError.message}`)
          );
        }
      }
      console.log(`[API Containers] Ensured volume exists: ${volumeName}`);

      // Ensure no conflicting container name exists
      const containerName = `codeyarn-session-${projectId}`;
      const existingNamedContainer = await getContainerSafely(containerName); // Use central helper
      if (existingNamedContainer) {
        console.warn(
          `[API Containers] Removing existing container with conflicting name ${containerName}.`
        );
        await existingNamedContainer
          .remove({ force: true })
          .catch((e) =>
            console.error(
              `[API Containers] Failed to remove conflicting container ${containerName}: ${e.message}`
            )
          );
      }

      // Prepare asset prefix for container environment
      const assetPrefix = `/preview/container/${finalHostPortToUseInResponse}`;
      console.log(`[API Containers] Setting ASSET_PREFIX: ${assetPrefix}`);

      // Define Docker container creation options
      const containerOptions: Docker.ContainerCreateOptions = {
        Image: template.dockerImage,
        name: containerName,
        Tty: true, // Allocate a pseudo-TTY for interactive sessions
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        OpenStdin: false,
        WorkingDir: process.env.CONTAINER_WORKSPACE || "/workspace",
        HostConfig: {
          Binds: [
            `${volumeName}:${process.env.CONTAINER_WORKSPACE || "/workspace"}`,
          ], // Mount project volume
          AutoRemove: false, // Do not remove container when it exits
          PortBindings: template.defaultPort
            ? {
                [`${template.defaultPort}/tcp`]: [
                  { HostPort: finalHostPortToUseInResponse.toString() },
                ],
              }
            : undefined,
          ExtraHosts: ["host.docker.internal:host-gateway"], // Allow container to reach host
        },
        Labels: {
          "codeyarn.project.id": projectId,
          "codeyarn.template.id": templateId,
        },
        Env: [
          `PROJECT_ID=${projectId}`,
          `NODE_ENV=development`,
          `PORT=${template.defaultPort}`,
          `WATCH_PATH=/workspace`, // For in-container watcher
          `BACKEND_HOST=${process.env.WATCHER_CALLBACK_HOST || "host.docker.internal"}`,
          `BACKEND_PORT=${process.env.PORT || 3001}`,
          `BACKEND_ENDPOINT=/api/internal/filesystem-event`,
          `ASSET_PREFIX=${assetPrefix}`, // For application asset paths
          `NEXT_PUBLIC_ASSET_PREFIX=${assetPrefix}`, // For Next.js public assets
        ],
        User: process.env.CONTAINER_USER || "coder", // Run as non-root user
        Cmd: template.startCommand
          ? template.startCommand.startsWith("/")
            ? [template.startCommand]
            : template.startCommand.split(" ")
          : undefined,
      };

      // Create and start the Docker container
      try {
        dockerContainerInstance =
          await docker.createContainer(containerOptions); // Use central docker instance
        containerIdForCleanup = dockerContainerInstance.id; // Mark for potential cleanup

        await dockerContainerInstance.start();

        const inspectInfo = await dockerContainerInstance.inspect();
        console.log(`[API Containers] New container ${inspectInfo.Id} started. 
                    Requested HostPort: ${finalHostPortToUseInResponse}.`);

        // Verify actual port binding
        const internalPortKey = template.defaultPort
          ? `${template.defaultPort}/tcp`
          : undefined;
        const portBindingsFromInspect = inspectInfo.NetworkSettings.Ports;
        let actualBoundHostPort: number | null = null;

        if (
          internalPortKey &&
          portBindingsFromInspect &&
          portBindingsFromInspect[internalPortKey]?.[0]?.HostPort
        ) {
          actualBoundHostPort = parseInt(
            portBindingsFromInspect[internalPortKey][0].HostPort
          );
        }
        if (actualBoundHostPort !== finalHostPortToUseInResponse) {
          const portMismatchError = `CRITICAL PORT MISMATCH: Requested ${finalHostPortToUseInResponse}, 
                    Docker bound to ${actualBoundHostPort}. ASSET_PREFIX will be incorrect.`;
          console.error(`[API Containers] ${portMismatchError}`);
          if (dockerContainerInstance) {
            // Check if instance was created
            await dockerContainerInstance.remove({ force: true }).catch((e) =>
              console.error(`[API Containers] Cleanup failed for misconfigured container 
                                    ${containerIdForCleanup}: ${e.message}`)
            );
          }
          return next(new Error(portMismatchError));
        }
      } catch (creationError: any) {
        console.error(
          `[API Containers] Error creating/starting container for 
                    project ${projectId}: ${creationError.message}`,
          creationError
        );
        if (dockerContainerInstance && containerIdForCleanup) {
          // If created but failed to start/inspect
          await dockerContainerInstance.remove({ force: true }).catch((e) =>
            console.error(`[API Containers] Cleanup attempt failed for container 
                                ${containerIdForCleanup}: ${e.message}`)
          );
        }
        return next(
          new Error(`Container creation/start failed: ${creationError.message}`)
        );
      }

      // Populate workspace and create initial file records in DB
      if (dockerContainerInstance) {
        // Ensure instance is valid
        await populateWorkspaceAndCreateDbFilesImpl(
          dockerContainerInstance,
          projectId,
          {
            id: template.id,
            sourceHostPath: template.sourceHostPath,
          }
        );
      } else {
        // This should ideally be caught by prior error handling
        throw new Error(
          "Docker container instance was not available for workspace population."
        );
      }

      // Create DB record for the new container
      const finalContainerInstance = await getContainerSafely(
        containerIdForCleanup!
      ); // Re-fetch for final state
      if (!finalContainerInstance) {
        throw new Error(
          `Failed to re-retrieve container ${containerIdForCleanup} after creation for DB record.`
        );
      }
      const finalInspectInfo = await finalContainerInstance.inspect();
      const containerDataForDb = {
        id: finalInspectInfo.Id,
        status: (finalInspectInfo.State.Running
          ? "RUNNING"
          : finalInspectInfo.State.Status.toUpperCase()) as ContainerStatus,
        hostPort: finalHostPortToUseInResponse,
        internalPort: template.defaultPort,
        projectId: projectId,
        templateId: templateId,
        startedAt:
          finalInspectInfo.State.Running && finalInspectInfo.State.StartedAt
            ? new Date(finalInspectInfo.State.StartedAt)
            : null,
        createdAt: new Date(finalInspectInfo.Created),
      };
      dbContainerRecord = await prisma.container.create({
        data: containerDataForDb,
        select: {
          id: true,
          status: true,
          hostPort: true,
          internalPort: true,
          projectId: true,
          templateId: true,
          createdAt: true,
          startedAt: true,
          stoppedAt: true,
        },
      });
      console.log(`[API Containers] New DB record for container ${dbContainerRecord.id} 
                created with hostPort ${dbContainerRecord.hostPort}`);
    }

    // --- 6. Final DB Record Validation & Project Link ---
    if (!dbContainerRecord || !dbContainerRecord.id) {
      // This should not be reached if logic above is correct
      throw new Error("Container DB record could not be established or found.");
    }

    // Ensure project is linked to the (new or existing) container ID
    if (project.containerId !== dbContainerRecord.id) {
      await prisma.project.update({
        where: { id: projectId },
        data: { containerId: dbContainerRecord.id },
      });
      console.log(`[API Containers] Project ${projectId} 
                linked to container ID ${dbContainerRecord.id}.`);
    }

    // --- 7. Format and Send Response ---
    const responseContainerData: SharedContainer = {
      id: dbContainerRecord.id,
      projectId: dbContainerRecord.projectId,
      templateId: dbContainerRecord.templateId,
      status: dbContainerRecord.status,
      hostPort: dbContainerRecord.hostPort, // Will be the determined finalHostPortToUseInResponse
      createdAt: dbContainerRecord.createdAt.toISOString(),
      startedAt: dbContainerRecord.startedAt
        ? dbContainerRecord.startedAt.toISOString()
        : undefined,
      stoppedAt: dbContainerRecord.stoppedAt
        ? dbContainerRecord.stoppedAt.toISOString()
        : undefined,
    };
    res
      .status(wasNewContainerActuallyCreated ? 201 : 200)
      .json(responseContainerData);
  } catch (error: any) {
    // --- 8. General Error Handling & Cleanup ---
    console.error(
      `[API Containers] General Error in POST / (Project: ${projectId}, Template: ${templateId}):`,
      error.message,
      error.stack
    );
    // If a new container was being created and an error occurred, attempt cleanup
    if (wasNewContainerActuallyCreated && containerIdForCleanup) {
      console.log(`[API Containers] Error occurred during new container setup. 
                Attempting cleanup for Docker container ${containerIdForCleanup}.`);
      try {
        const containerToClean = docker.getContainer(containerIdForCleanup); // Use central docker instance
        await containerToClean.remove({ force: true }).catch(() => {
          /* Ignore if already gone or fails */
        });
        console.log(
          `[API Containers] Cleaned up Docker container ${containerIdForCleanup} after error.`
        );
      } catch (cleanupError: any) {
        if (cleanupError.statusCode !== 404) {
          // 404 means it's already gone
          console.error(
            `[API Containers] Error during cleanup of Docker container ${containerIdForCleanup}:`,
            cleanupError.message
          );
        }
      }
    }
    next(error); // Pass to central error handler
  }
}

export async function startContainerHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { id } = req.params;

  // --- 1. Validate Input Parameter ---
  if (typeof id !== "string" || !id) {
    return res.status(400).json({ message: "Invalid container ID provided" });
  }
  console.log(`[API Containers] Request received to start container: ${id}`);

  try {
    // --- 2. Fetch Container Record from Database ---
    const dbContainer = await prisma.container.findUnique({
      where: { id },
      // Consider selecting specific fields if not all are needed:
      // select: { id: true, status: true, hostPort: true }
    });

    // Handle case: Container not found in DB
    if (!dbContainer) {
      console.warn(`[API Containers] Container ${id} not found in database.`);
      return res.status(404).json({ message: "Container record not found" });
    }

    // Handle case: Container already marked as RUNNING in DB
    if (dbContainer.status === "RUNNING") {
      console.log(
        `[API Containers] Container ${id} already marked as running in DB.`
      );
      return res.status(200).json({
        message: "Container is already running",
        containerId: id,
        status: "RUNNING",
        hostPort: dbContainer.hostPort,
      });
    }

    // Handle case: Container marked as DELETED in DB
    if (dbContainer.status === "DELETED") {
      console.warn(
        `[API Containers] Attempt to start a deleted container record: ${id}`
      );
      return res.status(404).json({ message: "Container has been deleted" });
    }

    // --- 3. Verify Docker Container State ---
    const container = await getContainerSafely(id); // Use centralized helper

    // Handle case: Container in DB but not found in Docker (discrepancy)
    if (!container) {
      console.error(`[API Containers] Container ${id} found in DB 
                (status: ${dbContainer.status}) but not found in Docker!`);
      // Update DB to reflect the error state
      await prisma.container.update({
        where: { id },
        data: { status: "ERROR" },
      });
      return res.status(404).json({
        message:
          "Container not found in Docker engine, DB record marked as ERROR.",
      });
    }

    // Inspect the actual state of the Docker container
    const inspectDataBefore = await container.inspect();

    // Handle case: Docker container is already running (DB might be out of sync)
    if (inspectDataBefore.State.Running) {
      console.warn(`[API Containers] Container ${id} is running in Docker, 
                but DB status was ${dbContainer.status}. 
                Updating DB.`);
      // Sync DB status to RUNNING
      await prisma.container.update({
        where: { id },
        data: {
          status: "RUNNING",
          startedAt: inspectDataBefore.State.StartedAt
            ? new Date(inspectDataBefore.State.StartedAt)
            : new Date(),
        },
      });
      return res.status(200).json({
        message: "Container is already running (DB status synced)",
        containerId: id,
        status: "RUNNING",
        hostPort: dbContainer.hostPort, // Use port from original DB record
      });
    }

    // --- 4. Start the Docker Container ---
    await container.start();
    console.log(`[API Containers] Docker container started: ${id}`);

    // --- 5. Update Database Record ---
    const updatedDbContainer = await prisma.container.update({
      where: { id },
      data: {
        status: "RUNNING",
        startedAt: new Date(), // Set startedAt to current time
      },
    });

    // --- 6. Send Success Response ---
    res.status(200).json({
      message: "Container started successfully",
      containerId: id,
      status: "RUNNING",
      hostPort: updatedDbContainer.hostPort, // Use potentially updated hostPort if logic changed it
    });
  } catch (error: any) {
    console.error(
      `[API Containers] Failed to start container ${id}:`,
      error.message,
      error.stack
    );
    // Attempt to mark container as ERROR in DB on failure
    try {
      await prisma.container.update({
        where: { id }, // This assumes 'id' is valid and the record exists
        data: { status: "ERROR" },
      });
    } catch (dbUpdateError: any) {
      // Log error if updating DB status also fails, but proceed to call next(error)
      console.error(
        `[API Containers] Failed to update DB status to ERROR for ${id} after start failure:`,
        dbUpdateError.message
      );
    }
    next(error); // Pass to central error handler
  }
}

export async function stopContainerHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { id } = req.params;

  // --- 1. Validate Input Parameters ---
  if (typeof id !== "string" || !id) {
    return res.status(400).json({ message: "Invalid container ID provided" });
  }

  // Parse timeout, default to 10 seconds
  const timeout = req.query.timeout
    ? parseInt(req.query.timeout as string, 10)
    : 10;
  console.log(
    `[API Containers] Request received to stop container: ${id} (timeout: ${timeout}s)`
  );

  try {
    // --- 2. Attempt to Get Docker Container Instance ---
    const container = await getContainerSafely(id); // Use centralized helper
    let dbStatusToUpdate: ContainerStatus = "STOPPED"; // Default to STOPPED

    // Handle case: Docker container not found
    if (!container) {
      console.warn(
        `[API Containers] Container ${id} not found in Docker during stop request.`
      );
      // Check DB to see if we knew about it and if it needs a status update
      const dbContainer = await prisma.container.findUnique({ where: { id } });
      if (
        dbContainer &&
        dbContainer.status !== "STOPPED" &&
        dbContainer.status !== "DELETED"
      ) {
        await prisma.container.update({
          where: { id },
          data: { status: "STOPPED", stoppedAt: new Date() },
        });
        console.log(`[API Containers] Updated DB status for ${id} 
                    to STOPPED as container not found in Docker.`);
      }
      // Respond based on whether the DB record existed
      return res.status(dbContainer ? 200 : 404).json({
        message: dbContainer
          ? "Container already stopped or removed (not found in Docker)"
          : "Container not found",
        containerId: id,
        status: "STOPPED",
      });
    }

    // --- 3. Process Docker Container ---
    const inspectData = await container.inspect();

    // Handle case: Docker container is already not running
    if (!inspectData.State.Running) {
      console.log(
        `[API Containers] Container ${id} is already stopped in Docker.`
      );
      // dbStatusToUpdate is already 'STOPPED'
    } else {
      // If running, attempt to stop it
      await container.stop({ t: timeout }); // 't' is the timeout in seconds for stop
      console.log(`[API Containers] Docker container stopped: ${id}`);
      // dbStatusToUpdate is already 'STOPPED'
    }

    // --- 4. Update Database Record ---
    await prisma.container.update({
      where: { id },
      data: {
        status: dbStatusToUpdate,
        stoppedAt: new Date(), // Record the time it was effectively stopped
      },
    });

    // --- 5. Send Success Response ---
    res.status(200).json({
      message: "Container stopped successfully",
      containerId: id,
      status: "STOPPED",
    });
  } catch (error: any) {
    console.error(
      `[API Containers] Failed to stop container ${id}:`,
      error.message,
      error.stack
    );

    // Handle Docker's 304 "Not Modified" which can mean it was already stopped
    if (error.statusCode === 304) {
      console.log(`[API Containers] Container ${id} reported as already stopped by Docker (304). 
                Ensuring DB is updated.`);
      try {
        await prisma.container.update({
          where: { id },
          data: { status: "STOPPED", stoppedAt: new Date() },
        });
      } catch (dbUpdateError: any) {
        if (dbUpdateError.code !== "P2025") {
          // P2025: failed due to records that were required but not found
          console.error(
            `[API Containers] Failed to update DB status 
                        for ${id} after 304 error:`,
            dbUpdateError.message
          );
        } else {
          console.warn(`[API Containers] DB record 
                        for ${id} not found when trying to update after 304.`);
        }
      }
      return res.status(200).json({
        message: "Container was already stopped",
        containerId: id,
        status: "STOPPED",
      });
    }

    // For other errors, attempt to mark container as ERROR in DB
    try {
      await prisma.container.update({
        where: { id }, // This assumes 'id' is valid and the record exists
        data: { status: "ERROR" },
      });
    } catch (dbUpdateError: any) {
      if (dbUpdateError.code !== "P2025") {
        console.error(
          `[API Containers] Failed to update DB status to ERROR 
                    for ${id} after stop failure:`,
          dbUpdateError.message
        );
      } else {
        console.warn(`[API Containers] DB record for ${id} not found 
                    when trying to mark as ERROR after stop failure.`);
      }
    }
    next(error); // Pass to central error handler
  }
}

export async function deleteContainerHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { id } = req.params;

  // --- 1. Validate Input Parameters ---
  if (typeof id !== "string" || !id) {
    return res.status(400).json({ message: "Invalid container ID provided" });
  }
  const force = req.query.force === "true"; // Check for 'force' query parameter
  console.log(
    `[API Containers] Request received to delete container: ${id} (force: ${force})`
  );

  try {
    // --- 2. Attempt to Remove Docker Container ---
    const container = await getContainerSafely(id); // Use centralized helper

    if (container) {
      await container.remove({ force: force }); // Use force flag
      console.log(`[API Containers] Container removed from Docker: ${id}`);
    } else {
      console.log(`[API Containers] Container ${id} not found in Docker during delete request. 
                Will proceed to update DB if record exists.`);
    }

    // --- 3. Update Database Record to DELETED ---
    // This attempts to update, and handles if the record is already gone (P2025)
    const updatedDbContainer = await prisma.container
      .update({
        where: { id },
        data: {
          status: "DELETED",
          hostPort: null, // Clear hostPort as container is gone
          stoppedAt: new Date(), // Record time of deletion/stopping
        },
        select: { projectId: true, id: true }, // Select projectId for unlinking
      })
      .catch((err) => {
        if (err.code === "P2025") {
          // Prisma's "Record to update not found"
          console.log(`[API Containers] DB record for ${id} not found 
                    during delete (already deleted or never existed).`);
          return null; // Indicate DB record was not found/updated
        }
        throw err; // Rethrow other database errors
      });

    // --- 4. Unlink Container from Project if DB Record was Updated ---
    if (updatedDbContainer && updatedDbContainer.projectId) {
      console.log(`[API Containers] Marked container record as DELETED in DB: ${id}. 
                Unlinking from project ${updatedDbContainer.projectId}.`);
      await prisma.project
        .update({
          where: { id: updatedDbContainer.projectId },
          data: { containerId: null }, // Set project's containerId to null
        })
        .catch((err) =>
          // Log error but don't fail the whole operation if unlinking fails
          console.error(
            `[API Containers] Failed to unlink container ${id}
                     from project ${updatedDbContainer.projectId}:`,
            err.message
          )
        );
    } else if (!updatedDbContainer) {
      // This means the container record was not in the DB to begin with, or already marked.
      // If you need to find the project ID by other means to unlink, that logic would go here.
      // For now, we assume if updatedDbContainer is null, no further project unlinking is needed via this path.
      console.log(
        `[API Containers] No DB record found for ${id} to unlink from project.`
      );
    }

    // --- 5. Send Success Response ---
    // 200 OK might be more appropriate than 204 if a response body is sent.
    // If truly no content, 204 is fine. Given a message is sent, 200 is better.
    res.status(200).json({
      message: "Container removed successfully",
      containerId: id,
      status: "DELETED",
    });
  } catch (error: any) {
    console.error(
      `[API Containers] Failed to remove container ${id}:`,
      error.message,
      error.stack
    );
    // Note: Specific Docker errors (like container part of a swarm and not stoppable with simple remove)
    // might need more nuanced handling or DB status updates here (e.g., to 'ERROR').
    next(error); // Pass to central error handler
  }
}

export async function getContainerStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { id } = req.params;

  // --- 1. Validate Input Parameter ---
  if (typeof id !== "string" || !id) {
    return res.status(400).json({ message: "Invalid container ID provided" });
  }
  console.log(
    `[API Containers] Request received for status of container: ${id}`
  );

  try {
    let finalStatus: ContainerStatus;
    let dockerState: Docker.ContainerInspectInfo["State"] | undefined =
      undefined;
    let hostPort: number | null = null;

    // --- 2. Fetch Container Record from Database (Source of Truth) ---
    const dbContainer = await prisma.container.findUnique({
      where: { id },
      // Select all fields that might be returned or used for logic
      select: {
        id: true,
        status: true,
        hostPort: true,
        startedAt: true,
        stoppedAt: true,
      },
    });

    // Handle case: Container not found in DB or marked as DELETED
    if (!dbContainer || dbContainer.status === "DELETED") {
      console.log(
        `[API Containers] Container ${id} not found or marked deleted in DB.`
      );
      return res.status(404).json({
        message: "Container not found or deleted",
        containerId: id,
        status: "DELETED",
      });
    }
    hostPort = dbContainer.hostPort; // Get host port from the DB record

    // --- 3. Sync with Docker if DB Status Suggests It Might Be Active/Inactive ---
    // These are states where Docker's actual state is authoritative if available.
    const statusesToSyncWithDocker: ContainerStatus[] = [
      "RUNNING",
      "STOPPED",
      "UNKNOWN",
      "CREATING",
      "ERROR",
    ];

    if (statusesToSyncWithDocker.includes(dbContainer.status)) {
      const container = await getContainerSafely(id); // Use centralized helper

      if (!container) {
        // Discrepancy: DB thinks it exists (and not DELETED), but Docker says no.
        console.warn(`
                    [API Containers] Container ${id} found in DB (status: ${dbContainer.status})
                    but not in Docker. Updating DB status.`);
        // Consider the most appropriate status. If it was RUNNING/STOPPED and now gone,
        // it's effectively DELETED or an ERROR.
        finalStatus = "DELETED"; // Or 'ERROR' depending on desired logic for missing containers
        await prisma.container.update({
          where: { id },
          data: { status: finalStatus, stoppedAt: new Date() },
        });
      } else {
        // Container found in Docker, get its actual state.
        const inspectData = await container.inspect();
        dockerState = inspectData.State; // Store for response

        // Determine status based on Docker state
        const currentDockerStatus: ContainerStatus = dockerState.Running
          ? "RUNNING"
          : dockerState.Status === "exited"
            ? "STOPPED" // Common status for normally stopped
            : "UNKNOWN"; // Default for other states like 'created', 'paused', etc.

        finalStatus = currentDockerStatus; // Trust Docker's current state

        // Update DB if its status is inconsistent with Docker's actual state
        if (dbContainer.status !== finalStatus) {
          console.log(`[API Containers] Updating DB status for ${id} 
                        from ${dbContainer.status} to ${finalStatus} based on Docker state.`);
          await prisma.container.update({
            where: { id },
            data: {
              status: finalStatus,
              // Update timestamps accurately based on Docker state if transitioning
              ...(finalStatus === "RUNNING" && dockerState.StartedAt
                ? {
                    startedAt: new Date(dockerState.StartedAt),
                  }
                : {}),

              ...(finalStatus === "STOPPED" &&
              (dbContainer.status === "RUNNING" || !dbContainer.stoppedAt)
                ? {
                    stoppedAt: new Date(),
                  }
                : {}),

              // Clear startedAt if it's now stopped and was previously running
              ...(finalStatus === "STOPPED" && dbContainer.status === "RUNNING"
                ? {
                    startedAt: dbContainer.startedAt,
                  }
                : {}),
            },
          });
        }
      }
    } else {
      // For states like DELETED (already handled) or possibly others where DB is authoritative.
      // Or if dbContainer.status was already definitive and didn't need Docker check.
      finalStatus = dbContainer.status;
    }

    // --- 4. Send Success Response ---
    res.status(200).json({
      containerId: id,
      status: finalStatus,
      dockerState: dockerState, // Include detailed Docker state if available
      hostPort: hostPort, // Return known port from DB
    });
  } catch (error: any) {
    console.error(
      `[API Containers] Failed to get status for container ${id}:`,
      error.message,
      error.stack
    );
    next(error); // Pass to central error handler
  }
}

export async function getPreviewDetailsHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { id } = req.params;

  // --- 1. Validate Input Parameter ---
  if (typeof id !== "string" || !id) {
    return res.status(400).json({
      message: "Invalid container ID provided",
    });
  }
  console.log(
    `[API Containers] Request received for preview details of container: ${id}`
  );

  try {
    // --- 2. Fetch Container Details from Database ---
    const dbContainer = await prisma.container.findUnique({
      where: { id },
      select: {
        // Select only the fields needed for preview URL and status check
        status: true,
        hostPort: true,
        internalPort: true,
      },
    });

    // Handle case: Container record not found in DB
    if (!dbContainer) {
      return res.status(404).json({
        message: "Container record not found",
      });
    }

    // --- 3. Validate Container Status for Preview ---
    // Preview is generally only relevant for running or creating containers
    if (dbContainer.status !== "RUNNING" && dbContainer.status !== "CREATING") {
      console.log(`[API Containers] Preview requested for non-running container ${id}
                 (status: ${dbContainer.status})`);
      return res.status(409).json({
        // 409 Conflict: state precludes operation
        message: `Container is not running (status: ${dbContainer.status})`,
        status: dbContainer.status,
      });
    }

    // Handle case: Host port is not set (essential for preview URL)
    if (!dbContainer.hostPort) {
      console.warn(`[API Containers] Preview requested for container ${id}, 
                but hostPort is not set.`);
      return res.status(409).json({
        message: "Container is running but host port information is missing.",
        status: dbContainer.status,
      });
    }

    // --- 4. Determine Base URL for Preview (Handling Reverse Proxies) ---
    // Debug logs (kept as per original code for troubleshooting proxy configurations)
    console.log("--- DEBUG START: Preview URL Generation ---");
    console.log("req.protocol:", req.protocol); // Protocol seen by Express (e.g., 'http' or 'https' if trust proxy is working)
    console.log("req.hostname:", req.hostname); // Hostname seen by Express
    console.log("req.headers.host:", req.headers.host); // Original Host header from client/proxy
    console.log(
      'req.headers["x-forwarded-proto"]:',
      req.headers["x-forwarded-proto"]
    ); // Protocol from proxy
    console.log(
      'req.headers["x-forwarded-host"]:',
      req.headers["x-forwarded-host"]
    ); // Host from proxy
    console.log("req.socket.remoteAddress:", req.socket.remoteAddress); // IP of client or last proxy
    console.log("--- DEBUG END: Preview URL Generation ---");

    // Determine domain: prefer req.hostname (if trust proxy is on), fallback to Host header, then default
    const domain =
      req.hostname && req.hostname !== "localhost"
        ? req.hostname
        : req.headers.host && typeof req.headers.host === "string"
          ? req.headers.host.split(":")[0] // Remove port if present in Host header
          : "codeyarn.xyz"; // Fallback domain

    // Determine protocol: use req.protocol (respects 'trust proxy'), then sanitize
    let protocol = req.protocol;
    if (protocol !== "http" && protocol !== "https") {
      protocol = "https"; // Default to https if protocol is unusual
    }
    // Enforce https for non-localhost domains if current determined protocol is http
    // This handles cases where X-Forwarded-Proto might be http (internal) but site is https
    if (domain !== "localhost" && protocol === "http") {
      protocol = "https";
    }

    // --- 5. Construct and Log Preview URL ---
    const previewUrl = `${protocol}://${domain}/preview/container/${dbContainer.hostPort}/`;
    console.log(`[API Containers] Generated previewUrl: ${previewUrl}`);

    // --- 6. Send Success Response ---
    res.status(200).json({
      containerId: id,
      status: dbContainer.status,
      hostPort: dbContainer.hostPort,
      internalPort: dbContainer.internalPort,
      previewUrl: previewUrl,
    });
  } catch (error: any) {
    console.error(
      `[API Containers] Failed to get preview details for container ${id}:`,
      error.message,
      error.stack
    );
    next(error); // Pass to central error handler
  }
}

export async function getFileStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { id } = req.params;

  // --- 1. Validate Input Parameter ---
  if (typeof id !== "string" || !id) {
    return res.status(400).json({
      message: "Invalid container ID provided",
    });
  }

  try {
    // --- 2. Fetch Container Record from Database ---
    const containerRecord = await prisma.container.findUnique({
      // Renamed to avoid conflict
      where: { id },
      select: { id: true, projectId: true, status: true }, // Select necessary fields
    });

    // Handle case: Container not found in DB
    if (!containerRecord) {
      return res.status(404).json({
        message: "Container not found",
      });
    }

    // --- 3. Get Docker Container Instance ---
    const dockerContainerInstance = await getContainerSafely(id); // Use centralized helper

    // Handle case: Docker container not found
    if (!dockerContainerInstance) {
      // DB record exists, but Docker container is gone.
      console.warn(`[API Containers File Status] Docker container ${id} not found, 
                though DB record exists.`);
      return res.status(404).json({
        message: "Docker container not found",
      });
    }

    // --- 4. Execute 'stat' command in Container to get file modification time ---
    // This example specifically checks '/workspace/index.js'. Adapt path or make dynamic if needed.
    const filePathToStat = "/workspace/index.js";
    const statCommand = ["stat", "-c", "%Y", filePathToStat]; // '%Y' for seconds since Epoch

    // Note: Using execCmdInContainer for simpler commands is good.
    // For this specific 'stat' where only stdout is needed and it's simple, direct exec is also fine.
    // If using execCmdInContainer:
    // const execResult = await execCmdInContainer(dockerContainerInstance, statCommand, '/');
    // let output = execResult.stdout;
    // if (!execResult.success) { ... handle error ... }

    // Retaining original direct exec for precise control here:
    const exec = await dockerContainerInstance.exec({
      Cmd: statCommand,
      AttachStdout: true,
      AttachStderr: true, // Capture stderr for debugging if 'stat' fails
    });

    const stream = await exec.start({});
    let output = "";
    let stderrOutput = ""; // Capture stderr

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    stdoutStream.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    stderrStream.on("data", (chunk) => {
      stderrOutput += chunk.toString("utf8");
    });

    dockerContainerInstance.modem.demuxStream(
      stream,
      stdoutStream,
      stderrStream
    );

    // Wait for the stream to end (command execution finished)
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject); // Handle stream-level errors
    });

    // Check exec exit code
    const execInspect = await exec.inspect();
    if (execInspect.ExitCode !== 0) {
      console.error(`[API Containers File Status] 'stat' command for "${filePathToStat}" in ${id} failed. 
                Exit Code: ${execInspect.ExitCode}. 
                Stderr: ${stderrOutput.trim()}`);
      return res.status(200).json({
        // Non-crashing, but indicates an issue
        containerId: id,
        filesChanged: false,
        error: `Failed to stat file in container: ${stderrOutput.trim() || "stat command failed"}`,
        lastChecked: new Date().toISOString(),
      });
    }

    // --- 5. Process Modification Time and Determine if Changed ---
    const modTime = parseInt(output.trim(), 10); // Ensure radix 10

    if (isNaN(modTime)) {
      console.error(`[API Containers File Status] 'stat' command returned non-numeric output 
                for ${id}: "${output.trim()}"`);
      return res.status(200).json({
        containerId: id,
        filesChanged: false,
        error: `Invalid output from stat command: ${output.trim()}`,
        lastChecked: new Date().toISOString(),
      });
    }

    // Compare with last known modification time (from global map for simplicity)
    const lastModTime = global.fileWatchMap.get(id) || 0;
    const hasChanged = modTime > lastModTime;

    if (hasChanged) {
      global.fileWatchMap.set(id, modTime); // Update last known modification time
      console.log(`[API Containers File Status] File changes detected in container ${id} 
                for ${filePathToStat}`);
    }

    // --- 6. Send Success Response ---
    res.status(200).json({
      containerId: id,
      filesChanged: hasChanged,
      lastChecked: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(
      `[API Containers File Status] Failed to check file status for container ${id}:`,
      error.message,
      error.stack
    );
    // Send a non-crashing response for this polling endpoint
    res.status(200).json({
      containerId: id,
      filesChanged: false,
      error: error.message,
      lastChecked: new Date().toISOString(),
    });
  }
}

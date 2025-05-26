// src/routes/containerUtils.ts
import { docker } from "../dockerClient"; 
import prisma from "@codeyarn/db"; 
import fs from "fs-extra"; 
import path from "path";  
import tar from "tar-fs"; 
import { Duplex, PassThrough } from "stream"; 
import { Template } from "@codeyarn/shared-types"; 
import Docker from "dockerode";

// Defines the path to the workspace scanning script inside the Docker container.
export const SCAN_SCRIPT_PATH_IN_CONTAINER = "/usr/local/bin/scan-workspace.js";

// Asynchronously retrieves a Docker container instance by its ID or name.
export async function getDockerContainerInstance(
  containerIdOrName: string
): Promise<Docker.Container | null> {
  try {
    // Get a Docker.Container object representing the container.
    const container = docker.getContainer(containerIdOrName);
    // Inspect the container to confirm its existence and accessibility.
    await container.inspect();
    // Return the container object if inspection is successful.
    return container;
  } catch (error: any) {
    // If the container is not found (Docker API returns 404), return null.
    if (error.statusCode === 404) {
      return null;
    }
    // Log other errors and re-throw them.
    console.error(
      `[Docker Helper] Error inspecting container ${containerIdOrName}:`,
      error
    );
    throw error;
  }
}

/**
 * Populates a container's workspace with template files
 * and creates corresponding file records in the database.
 */
export async function populateWorkspaceAndCreateDbFilesImpl(
  container: Docker.Container, // The Docker container instance to populate.
  projectId: string, // The ID of the project this workspace belongs to.
  template: Pick<Template, "id"> & { sourceHostPath?: string | null } // Template info, including optional host path to source files.
): Promise<void> {
  console.log(
    `[WorkspacePopulation] Starting for project ${projectId}, template ${template.id}`
  );
  // Get the ID of the container for logging and operations.
  const containerId = container.id;

  // Check if a source path for template files is provided.
  if (!template.sourceHostPath) {
    console.warn(
      `[WorkspacePopulation] Template ${template.id} has no sourceHostPath. Skipping file copy.`
    );
  } else {
    // Validate the provided template source path.
    if (
      !(await fs.pathExists(template.sourceHostPath)) || // Check if path exists.
      !(await fs.stat(template.sourceHostPath)).isDirectory() // Check if path is a directory.
    ) {
      console.error(
        `[WorkspacePopulation] Template source path invalid: ${template.sourceHostPath}`
      );
      throw new Error(
        `Template source path invalid or not a directory: ${template.sourceHostPath}`
      );
    }
    // Try to copy template files into the container.
    try {
      console.log(
        `[WorkspacePopulation] Creating tar from: ${template.sourceHostPath}`
      );
      // Create a TAR stream from the template source directory.
      const tarStream = tar.pack(template.sourceHostPath);
      // Put the TAR archive into the container's /workspace/ directory.
      await container.putArchive(tarStream, { path: "/workspace/" });
      console.log(
        `[WorkspacePopulation] Copied files from ${template.sourceHostPath} to ${containerId}:/workspace/`
      );
    } catch (error) {
      // Handle errors during file copying.
      console.error(
        `[WorkspacePopulation] Error copying template files to ${containerId}:`,
        error
      );
      throw new Error("Failed to copy template files into workspace.");
    }
  }
  // After populating with template files (if any), scan the container's workspace to create DB file records.
  await createFileRecordsFromContainer(container, projectId);
  console.log(`[WorkspacePopulation] Completed for project ${projectId}`);
}

/**
 * Run a scan script inside a Docker container, parse the returned JSON,
 * and store/update file entries in the database.
 */
export async function createFileRecordsFromContainer(
  container: Docker.Container, // The Docker container instance to scan.
  projectId: string // The ID of the project for associating file records.
): Promise<void> {
  console.log(
    `[DB Files] Starting workspace scan for container ${container.id}, project ${projectId}`
  );
  // Initialize fileListJson to an empty array string as a fallback.
  let fileListJson = "[]";
  try {
    // First, check if the scan script exists in the container.
    try {
      const testExec = await container.exec({
        Cmd: ["test", "-f", SCAN_SCRIPT_PATH_IN_CONTAINER], // Command to test for file existence.
        AttachStdout: false, // Don't need stdout for 'test -f'.
        AttachStderr: false, // Don't need stderr for 'test -f'.
      });
      await testExec.start({}); // Start and wait for the test command.
      console.log(
        `[DB Files] Scan script found at ${SCAN_SCRIPT_PATH_IN_CONTAINER}.`
      );
    } catch (scriptCheckError) {
      // If script check fails (e.g., script not found), log a warning and throw an error.
      console.warn(
        `[DB Files] Scan script not found at ${SCAN_SCRIPT_PATH_IN_CONTAINER}. Using default workspace setup.`
      );
      throw new Error("Scan script not found");
    }

    // Execute the scan script in the container.
    const exec = await container.exec({
      Cmd: ["node", SCAN_SCRIPT_PATH_IN_CONTAINER], // Command to run the Node.js scan script.
      AttachStdout: true, // Attach stdout to capture the script's output.
      AttachStderr: true, // Attach stderr to capture any errors from the script.
      WorkingDir: "/workspace", // Set the working directory for the script.
    });
    console.log(
      `[DB Files] Executing scan script in container ${container.id}.`
    );

    // Start the execution and get the stream for output.
    const stream: Duplex = await exec.start({});

    // Initialize strings to capture stdout and stderr.
    let stdout = "";
    let stderr = "";
    console.log(`[DB Files] Capturing scan script output.`);
    // Create PassThrough streams to pipe and collect stdout/stderr.
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    // Append data chunks to stdout/stderr strings.
    stdoutStream.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    stderrStream.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    // Demultiplex the Docker stream into separate stdout and stderr streams.
    container.modem.demuxStream(stream, stdoutStream, stderrStream);

    // Wait for the stream to end (command finished).
    await new Promise<void>((resolve, reject) => {
      stream.on("end", () => {
        // Log captured output once the stream has ended.
        console.log(
          `[DB Files] Captured scan script output (on end): ${stdout.trim()}`
        );
        console.log(
          `[DB Files] Captured scan script error (on end): ${stderr.trim()}`
        );
        resolve();
      });
      stream.on("error", reject); // Handle stream errors.
    });

    // Inspect the execution results to get the exit code.
    const inspectData = await exec.inspect();
    console.log(
      `[DB Files] Scan script in container ${container.id} exited with code ${inspectData.ExitCode}.`
    );

    // If the script exited with a non-zero code, log an error.
    if (inspectData.ExitCode !== 0) {
      console.error(
        `[DB Files] Scan script in container ${container.id} exited with code ${inspectData.ExitCode}. Stderr: ${stderr.trim()}`
      );
      // fileListJson remains "[]" as a fallback.
    } else {
      // If successful, use the script's stdout as the JSON file list.
      fileListJson = stdout.trim();
      console.log(
        `[DB Files] Scan script in container ${container.id} produced stdout output: ${stdout.trim()}`
      );
      // Log any stderr output as a warning, even on success.
      if (stderr.trim()) {
        console.warn(
          `[DB Files] Scan script in container ${container.id} produced stderr output: ${stderr.trim()}`
        );
      }
    }
  } catch (error) {
    // Handle errors during script execution.
    console.error(
      `[DB Files] Error executing scan script in container ${container.id}:`,
      error
    );
    // fileListJson remains "[]" as a fallback.
  }

  // Define the expected structure for entries parsed from the scan script's JSON output.
  let rawFileEntries: {
    name: string;
    path: string;
    isDirectory: boolean;
    content?: string; // Content is optional, might not be provided for all files by the script.
  }[] = [];
  // Try to parse the JSON output from the scan script.
  try {
    rawFileEntries = JSON.parse(fileListJson);
  } catch (e) {
    // Handle JSON parsing errors.
    console.error(
      "[DB Files] Failed to parse file structure JSON from scan script output:",
      e,
      "Raw JSON received:",
      `"${fileListJson}"` // Log the raw JSON for debugging.
    );
    // If JSON was empty or an empty array string, log it but don't re-throw for this specific case.
    if (fileListJson.trim() === "" || fileListJson.trim() === "[]") {
      console.log(
        "[DB Files] Scan script returned empty or no valid JSON. Ensuring /workspace root exists."
      );
    } else {
      // Re-throw if parsing failed on non-empty, non-array JSON, as it indicates a more serious issue.
      throw new Error("Failed to parse workspace scan result.");
    }
  }

  // Ensure a /workspace root entry exists, as the scan script might not list the root itself.
  if (!rawFileEntries.some((entry) => entry.path === "/workspace")) {
    // Check if a /workspace root already exists in the DB for this project.
    const workspaceRootExists = await prisma.file.findFirst({
      where: { projectId, path: "/workspace" },
    });
    // If not in DB, add it to the list to be created.
    if (!workspaceRootExists) {
      console.log(
        `[DB Files] Adding default /workspace root for project ${projectId}`
      );
      rawFileEntries.unshift({ // Add to the beginning of the array.
        name: "workspace",
        path: "/workspace",
        isDirectory: true,
      });
    }
  }

  // If no file entries (even after potentially adding /workspace), nothing more to do.
  if (rawFileEntries.length === 0) {
    console.log(
      `[DB Files] No files found by scan script for project ${projectId}. Workspace might be empty or scan failed.`
    );
    return;
  }

  // Sort entries by path depth to ensure parent directories are created before their children.
  rawFileEntries.sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length
  );
  // Map to store the DB IDs of created directories, mapping their path to their ID.
  const createdNodesMap = new Map<string, string>();

  // Iterate over each file/directory entry from the scan script.
  for (const entry of rawFileEntries) {
    // Normalize the entry path to ensure consistency (leading slash, no trailing slash unless root).
    let normalizedEntryPath = path.posix.normalize(entry.path);
    if (!normalizedEntryPath.startsWith("/"))
      normalizedEntryPath = "/" + normalizedEntryPath;
    if (normalizedEntryPath.endsWith("/") && normalizedEntryPath !== "/")
      normalizedEntryPath = normalizedEntryPath.slice(0, -1);
    if (normalizedEntryPath === "") normalizedEntryPath = "/"; // Should ideally be /workspace

    // Determine the parent directory's path and its ID.
    const parentDirSystemPath = path.posix.dirname(normalizedEntryPath);
    let parentId: string | null = null;

    // Handle parent ID lookup for different path structures.
    if (normalizedEntryPath === "/workspace") {
      // The /workspace root has no parent in this context.
      parentId = null;
    } else if (
      parentDirSystemPath === "/" || // Path like /file.txt (parent is logical root)
      parentDirSystemPath === "/workspace" // Path like /workspace/file.txt (parent is /workspace)
    ) {
      // Items directly under /workspace. Their parent is the /workspace node.
      parentId = createdNodesMap.get("/workspace") || null;
      // Defensive check: if /workspace wasn't in createdNodesMap, try fetching from DB.
      if (!parentId) {
        const rootNode = await prisma.file.findFirst({
          where: { projectId, path: "/workspace" }, // Assuming /workspace is the primary root.
        });
        if (rootNode) parentId = rootNode.id;
        else
          console.error(
            `[DB Files] Critical: /workspace root node not found for parent lookup of ${normalizedEntryPath}`
          );
      }
    } else {
      // For deeper paths, get parent ID from the map of already created nodes.
      parentId = createdNodesMap.get(parentDirSystemPath) || null;
    }

    // Check if a file/directory record already exists at this path for this project.
    const existingFile = await prisma.file.findFirst({
      where: { projectId, path: normalizedEntryPath },
    });

    // If it already exists, store its ID in the map (if not already there) and skip creation.
    if (existingFile) {
      if (!createdNodesMap.has(normalizedEntryPath)) {
        createdNodesMap.set(normalizedEntryPath, existingFile.id);
      }
      console.log(
        `[DB Files] File record for ${normalizedEntryPath} already exists. ID: ${existingFile.id}`
      );
      continue; // Move to the next entry.
    }

    // Try to create the new file/directory record in the database.
    try {
      const fileRecord = await prisma.file.create({
        data: {
          name: entry.name,
          path: normalizedEntryPath,
          isDirectory: entry.isDirectory,
          projectId: projectId,
          parentId: parentId,
          content: entry.content || null, // Use content from scan script if available, else null.
        },
      });
      // Store the new record's ID in the map for potential parent lookups by its children.
      createdNodesMap.set(normalizedEntryPath, fileRecord.id);
      console.log(
        `[DB Files] Created DB record for ${normalizedEntryPath} (ID: ${fileRecord.id}, ParentID: ${parentId})`
      );
    } catch (dbError: any) {
      // Handle errors during database record creation.
      console.error(
        `[DB Files] Failed to create DB record for ${normalizedEntryPath} in project ${projectId}. ParentPath: ${parentDirSystemPath}, Resolved ParentID: ${parentId}. Error:`,
        dbError.message
      );
    }
  }
  // Log the total number of DB records created/verified.
  console.log(
    `[DB Files] Created/verified ${createdNodesMap.size} DB file records for project ${projectId}`
  );
}
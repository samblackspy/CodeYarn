// src/services/dockerService.ts
import { docker } from "../dockerClient"; // Import the single instance
import Docker from "dockerode";
import { PassThrough, Duplex } from "stream";

export async function getContainerSafely(
  containerId: string
): Promise<Docker.Container | null> {
  try {
    const container = docker.getContainer(containerId);
    await container.inspect();
    return container;
  } catch (error: any) {
    if (error.statusCode === 404) {
      console.warn(`[DockerService] Container not found: ${containerId}`);
      return null;
    }
    console.error(
      `[DockerService] Error inspecting container ${containerId}:`,
      error
    );
    throw error;
  }
}

export async function execCmdInContainer(
  container: Docker.Container, // Or containerId: string, and then get it here
  cmd: string[],
  workingDir: string = "/workspace"
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  // ... (implementation using the imported 'docker' instance if needed, or just the passed container)
  console.log(
    `[DockerService] Running in ${container.id}: ${cmd.join(" ")} at ${workingDir}`
  );
  // ... (rest of the exec logic) ...
  // The existing execCmdInContainer seems to operate on a passed 'container' object,
  // which is fine. The key is that the Docker.Container object itself was obtained
  // using the central 'docker' instance.
  let execOutput = "";
  let execError = "";
  try {
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: workingDir,
      Tty: false,
    });
    const stream: Duplex = await exec.start({});

    const outputStream = new PassThrough();
    const errorStream = new PassThrough();
    outputStream.on("data", (chunk) => (execOutput += chunk.toString("utf-8")));
    errorStream.on("data", (chunk) => (execError += chunk.toString("utf-8")));
    container.modem.demuxStream(stream, outputStream, errorStream);

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    const inspectData = await exec.inspect();
    if (inspectData.ExitCode !== 0) {
      console.error(
        `[DockerService] Command "${cmd.join(" ")}" failed. Code: ${inspectData.ExitCode}. Stderr: ${execError.trim()}`
      );
      return {
        success: false,
        stdout: execOutput.trim(),
        stderr: execError.trim(),
      };
    }
    return {
      success: true,
      stdout: execOutput.trim(),
      stderr: execError.trim(),
    };
  } catch (error: any) {
    console.error(
      `[DockerService] Error in execCmd "${cmd.join(" ")}":`,
      error.message
    );
    return {
      success: false,
      stdout: execOutput.trim(),
      stderr: execError.trim() || error.message,
    };
  }
}

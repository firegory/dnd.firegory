import { spawn } from "node:child_process";
import { lstat, opendir } from "node:fs/promises";

import { TOOL_SIZE_POLL_MS } from "../../server/ingestion/limits.ts";

export type ToolFailureReason = "exit" | "timeout" | "stdout-limit" | "output-limit";

export class ToolExecutionError extends Error {
  readonly reason: ToolFailureReason;
  readonly exitCode: number | null;

  constructor(
    reason: ToolFailureReason,
    exitCode: number | null = null,
  ) {
    super(reason === "exit" ? `Tool exited with code ${exitCode ?? "unknown"}` : `Tool exceeded ${reason}`);
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

export async function runMonitoredTool(
  command: string,
  args: readonly string[],
  options: Readonly<{
    timeoutMs: number;
    maxStdoutBytes: number;
    maxOutputBytes?: number;
    monitorPaths?: readonly string[];
    monitorLimits?: readonly Readonly<{ path: string; maxBytes: number }>[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    pollMs?: number;
  }>,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure: ToolExecutionError | null = null;
    let polling = false;

    const killGroup = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const fail = (error: ToolExecutionError) => {
      if (failure || settled) return;
      failure = error;
      killGroup();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) return fail(new ToolExecutionError("stdout-limit"));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= options.maxStdoutBytes) stderr.push(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    const timeout = setTimeout(() => fail(new ToolExecutionError("timeout")), options.timeoutMs);
    const hasMonitors = Boolean(
      (options.maxOutputBytes && options.monitorPaths?.length) || options.monitorLimits?.length,
    );
    const poll = hasMonitors
      ? setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          const aggregateSizes = await Promise.all((options.monitorPaths ?? []).map(pathSizeOrZero));
          const limitSizes = await Promise.all((options.monitorLimits ?? []).map(async (monitor) => ({
            ...monitor,
            size: await pathSizeOrZero(monitor.path),
          })));
          if ((options.maxOutputBytes !== undefined
              && aggregateSizes.reduce((sum, size) => sum + size, 0) > options.maxOutputBytes)
            || limitSizes.some((monitor) => monitor.size > monitor.maxBytes)) {
            fail(new ToolExecutionError("output-limit"));
          }
        } catch (error) {
          fail(new ToolExecutionError("output-limit"));
        } finally {
          polling = false;
        }
      }, options.pollMs ?? TOOL_SIZE_POLL_MS)
      : undefined;
    poll?.unref();
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      if (poll) clearInterval(poll);
    };
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Tools must not leave helpers running after the direct child exits.
      killGroup();
      if (failure) return reject(failure);
      if (code !== 0) return reject(new ToolExecutionError("exit", code));
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

async function pathSizeOrZero(path: string): Promise<number> {
  try {
    return await pathSizeNoFollow(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function pathSizeNoFollow(path: string): Promise<number> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error("Monitored output contains a symbolic link");
  if (!metadata.isDirectory()) return metadata.size;
  let total = 0;
  const directory = await opendir(path);
  for await (const entry of directory) total += await pathSizeNoFollow(`${path}/${entry.name}`);
  return total;
}

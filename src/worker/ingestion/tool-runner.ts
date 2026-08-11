import { spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { TOOL_SIZE_POLL_MS } from "../../server/ingestion/limits.ts";

export type ToolFailureReason = "exit" | "timeout" | "stdout-limit" | "output-limit" | "monitor-error";

type MonitorLimit = Readonly<{
  path: string;
  maxBytes: number;
  kind?: "file" | "directory";
  label?: string;
}>;

export class ToolExecutionError extends Error {
  readonly reason: ToolFailureReason;
  readonly exitCode: number | null;
  readonly limitLabel: string | null;

  constructor(
    reason: ToolFailureReason,
    exitCode: number | null = null,
    limitLabel: string | null = null,
  ) {
    super(reason === "exit"
      ? `Tool exited with code ${exitCode ?? "unknown"}`
      : reason === "monitor-error"
        ? "Tool output monitoring failed"
        : `Tool exceeded ${reason}`);
    this.name = "ToolExecutionError";
    this.reason = reason;
    this.exitCode = exitCode;
    this.limitLabel = limitLabel;
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
    monitorLimits?: readonly MonitorLimit[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    pollMs?: number;
  }>,
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const directoryRoots = new Map<string, FileIdentity>();
  try {
    for (const monitor of options.monitorLimits ?? []) {
      if (monitor.kind === "directory") directoryRoots.set(monitor.path, await realDirectoryIdentity(monitor.path));
    }
  } catch {
    throw new ToolExecutionError("monitor-error");
  }

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
    let closing = false;
    let failure: ToolExecutionError | null = null;
    let monitorPromise: Promise<void> | null = null;

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

    const inspectMonitors = async () => {
      const aggregateSizes = await Promise.all((options.monitorPaths ?? []).map((path) => pathSizeOrZero(path)));
      const limitSizes = await Promise.all((options.monitorLimits ?? []).map(async (monitor) => ({
        ...monitor,
        size: monitor.kind === "directory"
          ? await directorySizeNoFollow(monitor.path, directoryRoots.get(monitor.path)!)
          : await pathSizeOrZero(monitor.path, monitor.kind),
      })));
      if (options.maxOutputBytes !== undefined
        && aggregateSizes.reduce((sum, size) => sum + size, 0) > options.maxOutputBytes) {
        fail(new ToolExecutionError("output-limit"));
        return;
      }
      const exceeded = limitSizes.find((monitor) => monitor.size > monitor.maxBytes);
      if (exceeded) fail(new ToolExecutionError("output-limit", null, exceeded.label ?? null));
    };
    const monitor = () => {
      if (monitorPromise) return;
      monitorPromise = inspectMonitors()
        .catch(() => fail(new ToolExecutionError("monitor-error")))
        .finally(() => { monitorPromise = null; });
    };
    const timeout = setTimeout(() => fail(new ToolExecutionError("timeout")), options.timeoutMs);
    const hasMonitors = Boolean(
      (options.maxOutputBytes !== undefined && options.monitorPaths?.length) || options.monitorLimits?.length,
    );
    const poll = hasMonitors ? setInterval(monitor, options.pollMs ?? TOOL_SIZE_POLL_MS) : undefined;
    poll?.unref();
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      if (poll) clearInterval(poll);
    };
    child.on("close", async (code) => {
      if (settled || closing) return;
      closing = true;
      cleanup();
      await monitorPromise;
      if (!failure && code === 0 && hasMonitors) {
        await inspectMonitors().catch(() => fail(new ToolExecutionError("monitor-error")));
      }
      settled = true;
      // Tools must not leave helpers running after the direct child exits.
      killGroup();
      if (failure) return reject(failure);
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const workspaceLimit = options.monitorLimits?.find((limit) => limit.kind === "directory");
      if (code !== 0 && workspaceLimit && /ENOSPC|no space left|disk quota exceeded/i.test(stderrText)) {
        return reject(new ToolExecutionError("output-limit", code, workspaceLimit.label ?? null));
      }
      if (code !== 0) return reject(new ToolExecutionError("exit", code));
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: stderrText });
    });
  });
}

type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

async function realDirectoryIdentity(path: string): Promise<FileIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Monitored root is not a real directory");
  return { dev: metadata.dev, ino: metadata.ino };
}

async function pathSizeOrZero(path: string, kind?: MonitorLimit["kind"]): Promise<number> {
  try {
    const metadata = await lstat(path);
    if (kind === "file" && !metadata.isFile()) {
      throw new Error("Monitored output is not a regular file");
    }
    return await pathSizeNoFollow(path, metadata);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function directorySizeNoFollow(path: string, expected: FileIdentity): Promise<number> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const current = await handle.stat({ bigint: true });
    if (current.dev !== expected.dev || current.ino !== expected.ino) throw new Error("Monitored root was replaced");
    return await openedDirectorySizeNoFollow(handle);
  } finally {
    await handle?.close();
  }
}

async function pathSizeNoFollow(path: string, knownMetadata?: Stats): Promise<number> {
  let metadata: Stats;
  try {
    metadata = knownMetadata ?? await lstat(path);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (!metadata.isDirectory()) return metadata.size;

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    // A nested entry may disappear or change type between lstat and open.
    // The next poll will account for its replacement without ever following it.
    if (isNestedDirectoryRace(error)) return 0;
    throw error;
  }

  try {
    return await openedDirectorySizeNoFollow(handle);
  } finally {
    await handle.close();
  }
}

async function openedDirectorySizeNoFollow(handle: FileHandle): Promise<number> {
  let total = 0;
  // /proc/self/fd pins every parent directory while child names are inspected.
  const pinnedPath = `/proc/self/fd/${handle.fd}`;
  const directory = await opendir(pinnedPath);
  for await (const entry of directory) total += await pathSizeNoFollow(join(pinnedPath, entry.name));
  return total;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNestedDirectoryRace(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP");
}

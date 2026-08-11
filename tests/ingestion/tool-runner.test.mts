import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runMonitoredTool, ToolExecutionError } from "../../src/worker/ingestion/tool-runner.ts";

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("kills a growing fake tool and its descendant process group at the live output cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-growth-"));
  const script = join(root, "grow.cjs");
  const output = join(root, "output.bin");
  const descendantOutput = join(root, "descendant.bin");
  const pidFile = join(root, "descendant.pid");
  await writeFile(script, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [output, descendantOutput, pidFile] = process.argv.slice(2);
fs.writeFileSync(descendantOutput, "");
const child = spawn(process.execPath, ["-e", "const fs=require('node:fs');const p=process.argv[1];setInterval(()=>fs.appendFileSync(p,Buffer.alloc(8192)),5)", descendantOutput], { stdio: "ignore" });
fs.writeFileSync(pidFile, String(child.pid));
setInterval(() => fs.appendFileSync(output, Buffer.alloc(16384)), 5);
`);
  try {
    await assert.rejects(runMonitoredTool(process.execPath, [script, output, descendantOutput, pidFile], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      monitorLimits: [{ path: root, maxBytes: 128 * 1024, kind: "directory", label: "OCR workspace" }],
      pollMs: 10,
    }), (error: unknown) => error instanceof ToolExecutionError
      && error.reason === "output-limit"
      && error.limitLabel === "OCR workspace");
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    const sizeAfterKill = (await stat(descendantOutput)).size;
    await wait(150);
    assert.equal((await stat(descendantOutput)).size, sizeAfterKill);
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces a distinct live regular-file cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-file-growth-"));
  const script = join(root, "grow.cjs");
  const output = join(root, "output.bin");
  await writeFile(script, `
const fs = require("node:fs");
setInterval(() => fs.appendFileSync(process.argv[2], Buffer.alloc(16384)), 5);
`);
  try {
    await assert.rejects(runMonitoredTool(process.execPath, [script, output], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      monitorLimits: [
        { path: output, maxBytes: 64 * 1024, kind: "file", label: "OCR output PDF" },
        { path: root, maxBytes: 4 * 1024 * 1024, kind: "directory", label: "OCR workspace" },
      ],
      pollMs: 10,
    }), (error: unknown) => error instanceof ToolExecutionError
      && error.reason === "output-limit"
      && error.limitLabel === "OCR output PDF");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies a hard workspace ENOSPC exit as the workspace limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-enospc-"));
  try {
    await assert.rejects(runMonitoredTool(process.execPath, [
      "-e", "console.error('ENOSPC: no space left on device'); process.exit(1)",
    ], {
      timeoutMs: 2_000,
      maxStdoutBytes: 1024,
      monitorLimits: [{ path: root, maxBytes: 1024, kind: "directory", label: "OCR workspace" }],
    }), (error: unknown) => error instanceof ToolExecutionError
      && error.reason === "output-limit"
      && error.limitLabel === "OCR workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not follow a nested symlink to an oversized outside target", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-symlink-"));
  const outside = join(tmpdir(), `tool-outside-${process.pid}-${Date.now()}.bin`);
  await writeFile(outside, "");
  await truncate(outside, 4 * 1024 * 1024);
  await symlink(outside, join(root, "origin"));
  try {
    const started = Date.now();
    await runMonitoredTool(process.execPath, ["-e", "setTimeout(() => {}, 150)"], {
      timeoutMs: 2_000,
      maxStdoutBytes: 1024,
      monitorLimits: [{ path: root, maxBytes: 64 * 1024, kind: "directory", label: "OCR workspace" }],
      pollMs: 10,
    });
    assert.ok(Date.now() - started >= 100);
    assert.equal((await stat(outside)).size, 4 * 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("fails closed when the monitored workspace root is replaced", async () => {
  const container = await mkdtemp(join(tmpdir(), "tool-root-swap-"));
  const root = join(container, "workspace");
  const moved = join(container, "workspace-moved");
  const outside = join(container, "outside");
  const script = join(container, "swap.cjs");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "outside");
  await writeFile(script, `
const fs = require("node:fs");
const [root, moved, outside] = process.argv.slice(2);
fs.renameSync(root, moved);
fs.symlinkSync(outside, root, "dir");
setInterval(() => {}, 1000);
`);
  try {
    await assert.rejects(runMonitoredTool(process.execPath, [script, root, moved, outside], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      monitorLimits: [{ path: root, maxBytes: 1024, kind: "directory", label: "OCR workspace" }],
      pollMs: 10,
    }), (error: unknown) => error instanceof ToolExecutionError && error.reason === "monitor-error");
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "outside");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
    await rm(container, { recursive: true, force: true });
  }
});

test("final scan catches a workspace root replaced by a short-lived tool", async () => {
  const container = await mkdtemp(join(tmpdir(), "tool-final-root-swap-"));
  const root = join(container, "workspace");
  const moved = join(container, "workspace-moved");
  const script = join(container, "swap-and-exit.cjs");
  await mkdir(root);
  await writeFile(script, `
const fs = require("node:fs");
const [root, moved] = process.argv.slice(2);
fs.renameSync(root, moved);
fs.mkdirSync(root);
`);
  try {
    await assert.rejects(runMonitoredTool(process.execPath, [script, root, moved], {
      timeoutMs: 2_000,
      maxStdoutBytes: 1024,
      monitorLimits: [{ path: root, maxBytes: 1024, kind: "directory", label: "OCR workspace" }],
      pollMs: 10_000,
    }), (error: unknown) => error instanceof ToolExecutionError && error.reason === "monitor-error");
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("tolerates nested entry mutation without following replacement links", async () => {
  const container = await mkdtemp(join(tmpdir(), "tool-mutation-"));
  const root = join(container, "workspace");
  const outside = join(container, "outside.bin");
  const script = join(container, "mutate.cjs");
  await mkdir(root);
  await writeFile(outside, "");
  await truncate(outside, 4 * 1024 * 1024);
  await writeFile(script, `
const fs = require("node:fs");
const path = require("node:path");
const [root, outside] = process.argv.slice(2);
const nested = path.join(root, "nested");
let iteration = 0;
const timer = setInterval(() => {
  fs.rmSync(nested, { recursive: true, force: true });
  if (iteration++ % 3 === 0) {
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "partial"), "partial");
  } else if (iteration % 3 === 1) fs.writeFileSync(nested, "file");
  else fs.symlinkSync(outside, nested);
}, 2);
setTimeout(() => { clearInterval(timer); fs.rmSync(nested, { recursive: true, force: true }); }, 200);
`);
  try {
    await runMonitoredTool(process.execPath, [script, root, outside], {
      timeoutMs: 2_000,
      maxStdoutBytes: 1024,
      monitorLimits: [{ path: root, maxBytes: 64 * 1024, kind: "directory", label: "OCR workspace" }],
      pollMs: 5,
    });
    await access(outside);
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("kills a fake tool process group on timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "tool-timeout-"));
  const script = join(root, "hang.cjs");
  const pidFile = join(root, "descendant.pid");
  await writeFile(script, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(child.pid));
setInterval(() => {}, 1000);
`);
  try {
    await assert.rejects(runMonitoredTool(process.execPath, [script, pidFile], {
      timeoutMs: 500,
      maxStdoutBytes: 1024,
    }), (error: unknown) => error instanceof ToolExecutionError && error.reason === "timeout");
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    await wait(150);
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

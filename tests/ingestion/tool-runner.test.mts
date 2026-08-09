import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      monitorLimits: [{ path: root, maxBytes: 128 * 1024 }],
      pollMs: 10,
    }), (error: unknown) => error instanceof ToolExecutionError && error.reason === "output-limit");
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    const sizeAfterKill = (await stat(descendantOutput)).size;
    await wait(150);
    assert.equal((await stat(descendantOutput)).size, sizeAfterKill);
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
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

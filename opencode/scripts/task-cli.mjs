#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
let TaskRunner, within, listTasks, readError, readJson;

const version = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), command = args.shift();
const help = "opencode-task launch --input-file PRIVATE_JSON [--continue-from TASK_ID]\n" +
  "opencode-task status TASK_ID\nopencode-task result TASK_ID\nopencode-task list [--state STATE] [--session NAME] [--limit 20] [--scan-limit 100] [--cursor CURSOR]\nopencode-task doctor [--quick]\nopencode-task cancel TASK_ID\nopencode-task recover [TASK_ID]\nlist/status/result/doctor 只读。recover 须显式调用，只观察原 request 或补投原 body。权限及未知结果边界见 TASKS.md。";

async function spawnControl(id, recover = false) {
  const child = spawn("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", "_run", id, "--ready", ...(recover ? ["--recover"] : [])], {
    cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  try {
    await within(new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("CONTROL_START_FAILED")));
      child.stdio[3].once("data", (data) => data.toString() === "ready\n" ? resolve() : reject(new Error("CONTROL_START_FAILED")));
    }), 10000);
  } finally {
    // 未收到 ACK 也不能推断未派发；保留原关联，后续仅显式 recover。
    child.stdio[3].destroy(); child.unref();
  }
}
function options(values, names) {
  const result = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!names.includes(values[i]) || !values[i + 1] || result[values[i]]) throw new Error("INVALID_ARGUMENTS");
    result[values[i]] = values[i + 1];
  }
  return result;
}
async function main() {
  if (["--help", "help", undefined].includes(command)) { console.log(help); return; }
  if (command === "--version") { console.log("opencode-task 2"); return; }
  if (!["launch", "status", "result", "list", "cancel", "recover", "_run"].includes(command)) throw new Error("INVALID_COMMAND");
  const root = readJson(path.join(version, "settings.json"), 65536).install_root;
  const runner = new TaskRunner({ root: path.join(root, "runtime/tasks") });
  if (command === "list") {
    console.log(JSON.stringify(listTasks(runner, options(args, ["--state", "--session", "--limit", "--scan-limit", "--cursor"])))); return;
  }
  if (command === "launch") {
    const { launchTask } = await import("./task-launch.mjs");
    const value = await launchTask(runner, options(args, ["--input-file", "--continue-from"]), { version, spawnControl });
    console.log(JSON.stringify(value)); if (value.error) process.exitCode = 1; return;
  }
  if (command === "recover") {
    if (args.length > 1) throw new Error("INVALID_ARGUMENTS");
    const unsupported = [], pending = args.length ? [args[0]] : runner.pending(unsupported);
    for (const id of pending) { runner.load(id); await spawnControl(id, true); }
    console.log(JSON.stringify({ version: 1, recovering: pending.length, unsupported })); return;
  }
  const id = args.shift();
  if (["status", "result"].includes(command)) {
    if (args.length) throw new Error("INVALID_ARGUMENTS");
    console.log(JSON.stringify(runner[command](id))); return;
  }
  const stored = runner.load(id);
  let runtime;
  try {
    if (command === "_run") {
      if (args.some((arg) => !["--ready", "--recover"].includes(arg)) || new Set(args).size !== args.length) throw new Error("INVALID_ARGUMENTS");
    } else if (args.length) throw new Error("INVALID_ARGUMENTS");
    if (!stored.result) {
      try {
        const { createTaskRuntime } = await import("./task-acp.mjs");
        runtime = createTaskRuntime(root, stored); runner.runtime = runtime;
      } catch (error) {
        if (command !== "_run" || !["queued", "preparing"].includes(stored.state)) throw error;
        // 明确尚未派发的安装/config 错误也沿原 outbox 报告。
        runner.fail(stored, "MODEL_OR_SESSION_SETUP_FAILED");
      }
    }
    if (command === "_run") {
      if (args.includes("--ready")) fs.writeSync(3, "ready\n");
      await runner.control(id, { observeOnly: args.includes("--recover") });
    }
    else { await runner.cancel(id); console.log(JSON.stringify(runner.status(id))); }
  } finally { if (runtime) await within(runtime.shutdown(), runner.ioMs).catch(() => {}); }
}
try {
  ({ listTasks, readError, readJson } = await import("./task-read.mjs"));
  ({ TaskRunner, within } = await import("./task.mjs"));
  await main();
}
catch (error) {
  const known = ["SESSION_MODEL_CONFLICT", "SUBMIT_CONFLICT", "SESSION_CWD_CONFLICT", "INVALID_COMMAND", "CONTROL_START_FAILED", "TASK_TERMINAL"];
  const code = !TaskRunner ? "TASK_MODULE_UNAVAILABLE" : known.includes(error.message) ? error.message : readError(error);
  console.error(JSON.stringify({ error: { code, hint: "核对 --help、TASKS.md 和私有状态；保留现场，不自动重发。" } }));
  process.exitCode = 1;
}
if (command === "_run") process.exit(process.exitCode ?? 0);

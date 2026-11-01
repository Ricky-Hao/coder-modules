#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
let TaskRunner, within, listTasks, readError, readJson, TaskError, errorCode, errorInfo, runtimeError;
let context = { stage: "runtime", field: "installation" }, taskRecorded, outcomeUnknown = false, recoveryConfirmed = 0;

const version = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), command = args.shift();
const help = "opencode-task launch --input-file PRIVATE_JSON [--continue-from TASK_ID]\n" +
  "opencode-task status TASK_ID\nopencode-task result TASK_ID\nopencode-task list [--state STATE] [--session NAME] [--limit 20]\nopencode-task doctor [--quick]\nopencode-task cancel TASK_ID\nopencode-task recover [TASK_ID]\n新 launch 默认 approve-all；continue 省略权限沿原保存值。list/status/result/doctor/help 只读。recover 只观察原 request 或补投原 body。受理不等于 started。未知时不换 key 重派。详见 TASKS.md。";

async function spawnControl(id, recover = false) {
  let child;
  try {
    child = spawn("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", "_run", id, "--ready", ...(recover ? ["--recover"] : [])], {
      cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
  } catch (error) { throw new TaskError("CONTROL_START_FAILED", { stage: "control", field: "control_ack", reason: error?.code }); }
  try {
    await within(new Promise((resolve, reject) => {
      child.once("error", (error) => reject(new TaskError("CONTROL_START_FAILED", { stage: "control", field: "control_ack", reason: error?.code })));
      child.once("exit", () => reject(new TaskError("CONTROL_ACK_UNKNOWN", { stage: "control", field: "control_ack", reason: "process_exit" })));
      child.stdio[3].once("data", (data) => data.toString() === "ready\n" ? resolve() : reject(new TaskError("CONTROL_ACK_UNKNOWN", { stage: "control", field: "control_ack", reason: "invalid_ack" })));
    }), 10000);
  } catch (error) {
    if (error instanceof TaskError && error.code !== "OBSERVATION_TIMEOUT") throw error;
    throw new TaskError("CONTROL_ACK_UNKNOWN", { stage: "control", field: "control_ack", reason: error instanceof TaskError && error.code === "OBSERVATION_TIMEOUT" ? "timeout" : "unknown" });
  } finally {
    // 未收到 ACK 也不能推断未派发；保留原关联，后续仅显式 recover。
    child.stdio[3].destroy(); child.unref();
  }
}
function options(values, names) {
  const result = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!names.includes(values[i]) || !values[i + 1] || result[values[i]]) throw new TaskError("INVALID_ARGUMENTS", { stage: "validate", field: "arguments" });
    result[values[i]] = values[i + 1];
  }
  return result;
}
async function main() {
  if (["--help", "-h", "help", undefined].includes(command)) { console.log(help); return; }
  if (["launch", "status", "result", "list", "cancel", "recover", "doctor"].includes(command) && args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(help); return; }
  if (command === "--version") { console.log("opencode-task 3"); return; }
  if (!["launch", "status", "result", "list", "cancel", "recover", "_run"].includes(command)) throw new TaskError("INVALID_COMMAND", { stage: "validate", field: "command" });
  const root = readJson(path.join(version, "settings.json"), 65536, { stage: "runtime", field: "settings" }).install_root;
  context = { stage: "read", field: "task_store" };
  const runner = new TaskRunner({ root: path.join(root, "runtime/tasks-v3") });
  if (command === "list") {
    console.log(JSON.stringify(listTasks(runner, options(args, ["--state", "--session", "--limit"])))); return;
  }
  if (command === "launch") {
    const { launchTask } = await import("./task-launch.mjs");
    const value = await launchTask(runner, options(args, ["--input-file", "--continue-from"]), { version, spawnControl });
    console.log(JSON.stringify(value)); if (value.error) process.exitCode = 1; return;
  }
  if (command === "recover") {
    if (args.length > 1) throw new TaskError("INVALID_ARGUMENTS", { stage: "validate", field: "arguments" });
    const pending = args.length ? [args[0]] : runner.pending();
    for (const id of pending) {
      // 后续读取失败不能沿用上一项的 request 或确认状态。
      context = { stage: "read", field: "task_record", task_id: id }; taskRecorded = null; outcomeUnknown = true;
      const task = runner.load(id); taskRecorded = true;
      context = { stage: "control", field: "control_ack", task_id: id, request_id: task.requestId };
      await spawnControl(id, true); recoveryConfirmed++;
    }
    console.log(JSON.stringify({ version: 1, recovering: pending.length })); return;
  }
  const id = args.shift();
  if (["status", "result"].includes(command)) {
    if (args.length) throw new TaskError("INVALID_ARGUMENTS", { stage: "validate", field: "arguments" });
    context = { stage: "read", field: "task_record", task_id: id };
    console.log(JSON.stringify(runner[command](id))); return;
  }
  const stored = runner.load(id);
  taskRecorded = true; outcomeUnknown = Boolean(stored.dispatchedAt && !stored.result);
  context = { stage: "setup", field: "installation", task_id: id, request_id: stored.requestId };
  let runtime;
  try {
    if (command === "_run") {
      if (args.some((arg) => !["--ready", "--recover"].includes(arg)) || new Set(args).size !== args.length) throw new TaskError("INVALID_ARGUMENTS", { stage: "validate", field: "arguments" });
    } else if (args.length) throw new TaskError("INVALID_ARGUMENTS", { stage: "validate", field: "arguments" });
    if (!stored.result) {
      try {
        const { createTaskRuntime } = await import("./task-acp.mjs");
        runtime = createTaskRuntime(root, stored); runner.runtime = runtime;
      } catch (error) {
        if (command !== "_run" || !["queued", "preparing"].includes(stored.state))
          throw runtimeError(error, { stage: "setup", field: "installation", fallback: "TASK_OPERATION_FAILED" });
        // 明确尚未派发的安装/config 错误也沿原 outbox 报告。
        runner.fail(stored, runtimeError(error, { stage: "setup", field: "installation", fallback: "MODEL_OR_SESSION_SETUP_FAILED" }));
      }
    }
    if (command === "_run") {
      context.stage = "control"; context.field = "control_ack"; outcomeUnknown = !stored.result;
      if (args.includes("--ready")) fs.writeSync(3, "ready\n");
      await runner.control(stored, { observeOnly: args.includes("--recover") });
    }
    else { context.stage = "cancel"; context.field = "request"; outcomeUnknown = !stored.result;
      await runner.cancel(id); console.log(JSON.stringify(runner.status(id))); }
  } finally { if (runtime) await within(runtime.shutdown(), runner.ioMs).catch(() => {}); }
}
try {
  ({ TaskError, errorCode, errorInfo, runtimeError } = await import("./task-errors.mjs"));
  ({ listTasks, readError, readJson } = await import("./task-read.mjs"));
  ({ TaskRunner, within } = await import("./task.mjs"));
  await main();
}
catch (error) {
  const detail = !TaskRunner ? { code: "TASK_MODULE_UNAVAILABLE", stage: "runtime", field: "installation", category: "configuration", reason: "unknown",
    action: "check_installation", hint: "任务模块未能加载；核对安装 inventory，保留原 task，不自动重发。" }
    : errorInfo(errorCode(error, context.stage === "read" ? readError(error) : "TASK_OPERATION_FAILED"),
      { ...context, ...(error instanceof TaskError ? error : {}) });
  console.error(JSON.stringify({ error: detail, ...(taskRecorded === undefined ? {} : { task_recorded: taskRecorded, outcome_unknown: outcomeUnknown }),
    ...(command === "recover" ? { recovery_confirmed: recoveryConfirmed } : {}) }));
  process.exitCode = 1;
}
if (command === "_run") process.exit(process.exitCode ?? 0);

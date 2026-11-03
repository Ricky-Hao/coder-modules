#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskStore, TaskError, diagnostic, readJson, save, taskPattern, within } from "./task.mjs";

const version = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), command = args.shift();
const help = `opencode-task launch --input-file PRIVATE_JSON [--continue-from TASK_ID]
opencode-task status TASK_ID
opencode-task result TASK_ID
opencode-task list [--phase PHASE] [--session NAME] [--limit 20]
opencode-task cancel TASK_ID
opencode-task recover [TASK_ID]
opencode-task doctor [--quick]
新 launch 默认 approve-all；continue 省略权限沿原保存值。本轮时限默认 900 秒。
所有公共入口先同步中心全局规则/Skill；help/version/status/result/list/doctor 不改业务记录。
恢复只用显式 recover，不重派原 request。
accepted 不等于 started；canonical success 不证明业务目标完成。详见 TASKS.md。`;
const invalid = () => { throw new TaskError("INVALID_ARGUMENTS", { stage: "validate", field: "arguments", action: "fix_input" }); };
function options(names) {
  const value = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!names.includes(args[i]) || !args[i + 1] || value[args[i]] !== undefined) invalid();
    value[args[i]] = args[i + 1];
  }
  return value;
}
async function spawnControl(id, recover = false) {
  const child = spawn("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", "_run", id, "--ready", ...recover ? ["--recover"] : []],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
  let text = "";
  try {
    return await within(new Promise((resolve, reject) => {
      const fail = (reason) => reject(new TaskError("CONTROL_ACK_UNKNOWN", { stage: "control", field: "control_ack", reason }));
      child.once("error", (error) => fail(error.code)); child.once("exit", () => fail("process_exit"));
      child.stdio[3].on("data", (data) => {
        text += data; if (text.length > 32768) return fail("invalid_ack");
        if (text.endsWith("\n")) { try { resolve(JSON.parse(text)); } catch { fail("invalid_ack"); } }
      });
    }), 10000);
  } catch (error) { throw new TaskError("CONTROL_ACK_UNKNOWN", { stage: "control", field: "control_ack", reason: error.reason }); }
  finally { child.stdio[3].destroy(); child.unref(); } // 不 kill：ACK 未知仍可能已经派发。
}
async function main() {
  if (!command || ["help", "--help", "-h"].includes(command) || args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(help); return; }
  if (command === "--version") { console.log("opencode-task 3"); return; }
  const root = readJson(path.join(version, "settings.json")).install_root;
  const store = new TaskStore(path.join(root, "runtime/tasks-v3"));
  if (command === "launch") {
    const { launchTask } = await import("./task-launch.mjs");
    const value = await launchTask(store, options(["--input-file", "--continue-from"]), { version, spawnControl });
    console.log(JSON.stringify(value)); if (value.error) process.exitCode = 1; return;
  }
  if (command === "list") {
    const flags = options(["--phase", "--session", "--limit"]);
    console.log(JSON.stringify(store.list(Object.fromEntries(Object.entries(flags).map(([key, value]) => [key.slice(2), value]))))); return;
  }
  if (command === "recover") {
    if (args.length > 1) invalid();
    const ids = args.length ? args : fs.readdirSync(store.root).filter((id) => taskPattern.test(id));
    let recovering = 0;
    for (const id of ids) {
      const task = store.load(id), box = store.outbox(task);
      if (task.phase === "preparing") { if (args.length) throw new TaskError("PREPARATION_INCOMPLETE", { stage: "prepare", field: task.step }); continue; }
      if (task.result && box && box.state !== "pending") continue;
      await spawnControl(id, true); recovering++;
    }
    console.log(JSON.stringify({ version: 1, recovering })); return;
  }
  const id = args.shift();
  if (["status", "result", "cancel"].includes(command)) {
    if (args.length) invalid();
    const task = store.load(id);
    if (command === "cancel") {
      if (task.result) throw new TaskError("TASK_TERMINAL", { stage: "cancel", field: "request" });
      save(store.filename(id, "cancel.request"), { requested: true });
      if (task.dispatchedAt) {
        try { const { cancelTask } = await import("./task-acp.mjs"); if (!await within(cancelTask(task), 3000)) throw new Error(); }
        catch { throw new TaskError("CANCEL_UNCONFIRMED", { stage: "cancel", field: "request" }); }
      }
    }
    console.log(JSON.stringify(store.summary(task, { output: command === "result" }))); return;
  }
  if (command !== "_run" || args.some((arg) => !["--ready", "--recover"].includes(arg))) invalid();
  const task = store.load(id);
  task.workerStartedAt ??= store.now(); store.write(task);
  if (args.includes("--ready")) fs.writeSync(3, JSON.stringify(store.summary(task)) + "\n");
  const { TaskWorker } = await import("./task-worker.mjs");
  const worker = new TaskWorker(store, { connect: async (record) => {
    const { createTaskRuntime } = await import("./task-acp.mjs"); return createTaskRuntime(root, record);
  } });
  await worker.run(task, { recover: args.includes("--recover") });
}
try { await main(); }
catch (error) { console.error(JSON.stringify({ error: diagnostic(error, "runtime", "installation", "TASK_OPERATION_FAILED") })); process.exitCode = 1; }
if (command === "_run") process.exit(process.exitCode ?? 0);

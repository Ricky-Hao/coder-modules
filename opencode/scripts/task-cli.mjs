#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
let TaskRunner, deliveryState, healthPolicy, privateFile, within;
let launchDriver, supervise, workerHeartbeat, inspectTask, listTasks, readError, readJson;

const version = path.dirname(fileURLToPath(import.meta.url));
let root, loaded = false;
const args = process.argv.slice(2);
const command = args.shift();
const allowed = new Set([
  "submit",
  "status",
  "result",
  "list",
  "inspect",
  "cancel",
  "recover",
  "resolve",
  "_worker",
  "_observe",
  "_supervise",
  "_fail_launch",
]);
const help =
  "opencode-task submit --key KEY --prompt-file FILE [OPTIONS]\nopencode-task status TASK_ID\nopencode-task result TASK_ID\nopencode-task inspect TASK_ID\nopencode-task list [--state STATE] [--session NAME] [--limit 20] [--scan-limit 100] [--cursor CURSOR]\nopencode-task doctor [--quick]\nopencode-task cancel TASK_ID\nopencode-task recover [TASK_ID]\nopencode-task resolve TASK_ID --status success|error|cancelled --output-file FILE\nlist/inspect/doctor 只读，inspect 无 output。list 上限 50/200。doctor 默认完整校验；--quick 不读二进制内容/哈希。提交选项及完整边界见 TASKS.md；权限覆盖须已有授权。";

async function spawnWorker(id, action = "_supervise") {
  const child = spawn("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", action, id, "--ready"], {
    cwd: process.cwd(), env: process.env, detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  try {
    await within(new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("SUPERVISOR_START_FAILED")));
      child.stdio[3].once("data", (data) => data.toString() === "ready\n"
        ? resolve() : reject(new Error("SUPERVISOR_START_FAILED")));
    }), 10000);
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await stopped;
    }
    throw error;
  } finally {
    child.stdio[3].destroy();
    child.unref();
  }
}
function options(values, names) {
  const result = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!names.includes(values[i]) || !values[i + 1] || result[values[i]])
      throw new Error("INVALID_ARGUMENTS");
    result[values[i]] = values[i + 1];
  }
  return result;
}
function readBounded(filename, max, privateOnly = false) {
  if (privateOnly) privateFile(filename);
  const fd =
    filename === null
      ? 0
      : fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(max + 1);
    let count = 0;
    while (count < buffer.length) {
      const received = fs.readSync(
        fd,
        buffer,
        count,
        buffer.length - count,
        null,
      );
      if (!received) break;
      count += received;
    }
    if (count > max) throw new Error("INPUT_TOO_LARGE");
    return buffer.subarray(0, count).toString("utf8");
  } finally {
    if (fd !== 0) fs.closeSync(fd);
  }
}

async function main() {
  if (["--help", "help", undefined].includes(command)) {
    console.log(help);
    return;
  }
  if (command === "--version") {
    console.log("opencode-task 1");
    return;
  }
  if (!allowed.has(command)) throw new Error("INVALID_COMMAND");
  root = readJson(path.join(version, "settings.json"), 65536).install_root;
  let runtime;
  const runner = new TaskRunner({
    root: path.join(root, "runtime/tasks"),
    policy: ["list", "inspect", "status", "result"].includes(command) ? undefined : healthPolicy(process.env),
  });
  try {
    if (command === "list") {
      console.log(JSON.stringify(listTasks(runner, options(args, ["--state", "--session", "--limit", "--scan-limit", "--cursor"]))));
    } else if (command === "submit") {
      const flags = options(args, [
        "--key",
        "--prompt-file",
        "--callback-file",
        "--session",
        "--model",
        "--variant",
        "--permission-mode",
        "--permission-policy-file",
      ]);
      if (!flags["--key"] || !flags["--prompt-file"])
        throw new Error("INVALID_ARGUMENTS");
      const prompt = readBounded(flags["--prompt-file"], 1048576);
      const callback = JSON.parse(
        readBounded(
          flags["--callback-file"] ?? null,
          4096,
          Boolean(flags["--callback-file"]),
        ),
      );
      const accepted = runner.submit({
        key: flags["--key"],
        prompt,
        cwd: process.cwd(),
        callback,
        session: flags["--session"],
        model: process.env.OPENCODE_MODULE_TASK_SELECTION
          ? JSON.parse(process.env.OPENCODE_MODULE_TASK_SELECTION) : undefined,
        modelConfig: process.env.OPENCODE_MODULE_TASK_CONFIG,
        modelProfile: process.env.OPENCODE_MODULE_TASK_PROFILE,
        permissionMode: flags["--permission-mode"],
        permissionPolicy: flags["--permission-policy-file"]
          ? JSON.parse(
              readBounded(flags["--permission-policy-file"], 32768, true),
            )
          : undefined,
      });
      if (!["delivered", "rejected"].includes(deliveryState(runner.load(accepted.task_id)))) {
        try {
          await spawnWorker(accepted.task_id);
        } catch (error) {
          await spawnWorker(accepted.task_id, "_fail_launch").catch(() => {});
          throw error;
        }
      }
      console.log(JSON.stringify(accepted));
    } else if (command === "recover") {
      if (args.length > 1) throw new Error("INVALID_ARGUMENTS");
      const pending = args.length ? [args[0]] : runner.pending();
      for (const id of pending) { runner.load(id); await spawnWorker(id); }
      console.log(JSON.stringify({ version: 1, recovering: pending.length }));
    } else {
      const id = args.shift();
      if (["status", "result", "inspect"].includes(command)) {
        if (args.length) throw new Error("INVALID_ARGUMENTS");
        const value = command === "inspect" ? inspectTask(runner, id) : runner[command](id);
        console.log(JSON.stringify(value));
        return;
      }
      const stored = runner.load(id);
      let beat;
      if (["_worker", "_observe"].includes(command)) {
        if (args.length !== 1 || !/^[a-f0-9-]{36}$/.test(args[0])) throw new Error("INVALID_ARGUMENTS");
        beat = workerHeartbeat(runner, id, args[0]);
        runner.heartbeat = (phase) => beat.phase(phase);
      }
      if (command === "_supervise") {
        if (args.length > 1 || args.length && args[0] !== "--ready") throw new Error("INVALID_ARGUMENTS");
        if (args[0] === "--ready") fs.writeSync(3, "ready\n");
        await supervise(runner, id, (action, taskId, token) => launchDriver(version, taskId, token, action));
      } else if (["_worker", "_observe", "cancel"].includes(command) &&
          (!stored.body || command === "cancel" && stored.notificationKind === "supervision_failure")) {
        const { createTaskRuntime } = await import("./task-acp.mjs");
        runtime = createTaskRuntime(root, stored);
        runner.runtime = runtime;
      }
      if (["_worker", "_observe"].includes(command)) {
        await runner.execute(id, { observeOnly: command === "_observe" });
        let record = runner.load(id);
        if (record.state === "ambiguous" && !record.body) {
          runner.fail(record, record.executionError ?? "REQUEST_UNOBSERVABLE");
          record = runner.load(id);
        }
        beat.close();
      } else if (command === "_fail_launch") {
        if (args.length > 1 || args.length && args[0] !== "--ready") throw new Error("INVALID_ARGUMENTS");
        if (stored.state === "queued" && !stored.workerAttemptedAt && !stored.body) {
          runner.fail(stored, "SUPERVISOR_START_FAILED");
        }
        // Keep monitor.lock through retries; worker.lock is no longer needed after sealing.
        const [workerLock] = JSON.parse(process.env.OPENCODE_MODULE_TASK_LOCKS);
        fs.closeSync(workerLock);
        delete process.env.OPENCODE_MODULE_TASK_LOCKS;
        if (args[0] === "--ready") fs.writeSync(3, "ready\n");
        await supervise(runner, id, (action, taskId, token) => launchDriver(version, taskId, token, action));
      } else if (command === "resolve") {
        const flags = options(args, ["--status", "--output-file"]);
        if (!flags["--status"] || !flags["--output-file"])
          throw new Error("INVALID_ARGUMENTS");
        runner.resolve(
          id,
          flags["--status"],
          readBounded(flags["--output-file"], 32768),
        );
        // 交给 monitor 前释放两把锁。
        for (const lock of JSON.parse(process.env.OPENCODE_MODULE_TASK_LOCKS ?? "[]")) fs.closeSync(lock);
        delete process.env.OPENCODE_MODULE_TASK_LOCKS;
        await spawnWorker(id);
        console.log(JSON.stringify(runner.status(id)));
      } else if (command !== "_supervise") {
        if (args.length) throw new Error("INVALID_ARGUMENTS");
        if (command === "cancel") {
          await runner.cancel(id);
          await spawnWorker(id);
        }
        console.log(JSON.stringify(runner.status(id)));
      }
    }
  } finally {
    if (runtime) await within(runtime.shutdown(), runner.policy.probeMs).catch(() => {});
    if (process.env.OPENCODE_MODULE_SESSION_LOCK) {
      fs.closeSync(Number(process.env.OPENCODE_MODULE_SESSION_LOCK));
      delete process.env.OPENCODE_MODULE_SESSION_LOCK;
    }
  }
}

try {
  ({ inspectTask, listTasks, readError, readJson } = await import("./task-read.mjs"));
  ({ TaskRunner, deliveryState, healthPolicy, privateFile, within } = await import("./task.mjs"));
  ({ launchDriver, supervise, workerHeartbeat } = await import("./task-supervisor.mjs"));
  loaded = true;
  await main();
} catch (error) {
  // 仅输出安全码。
  const conflicts = ["SESSION_MODEL_CONFLICT", "SUBMIT_CONFLICT", "SESSION_CWD_CONFLICT"];
  const code = !loaded ? "TASK_MODULE_UNAVAILABLE" : conflicts.includes(error.message) || error.message === "INVALID_COMMAND" ? error.message : readError(error);
  const hint = conflicts.includes(code) ? "使用原意图或新的 key/session。"
    : code === "CURSOR_STALE" ? "不带 cursor 重查，按 task_id 去重。"
    : "核对 --help、TASKS.md 及私有状态；保留历史，不自动重发。";
  console.error(JSON.stringify({ error: { code, hint } }));
  process.exitCode = 1;
}
if (["_worker", "_observe"].includes(command)) process.exit(process.exitCode ?? 0);

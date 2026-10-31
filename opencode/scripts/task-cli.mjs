#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskRunner, deliveryState, healthPolicy, privateFile, within } from "./task.mjs";
import { launchDriver, supervise, workerHeartbeat } from "./task-supervisor.mjs";

const version = path.dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(
  fs.readFileSync(path.join(version, "settings.json"), "utf8"),
);
const root = settings.install_root;
const args = process.argv.slice(2);
const command = args.shift();
const allowed = new Set([
  "submit",
  "status",
  "result",
  "cancel",
  "recover",
  "resolve",
  "_worker",
  "_observe",
  "_supervise",
  "_fail_launch",
]);
const help =
  "opencode-task submit --key KEY --prompt-file FILE [--callback-file PRIVATE_FILE] [--session NAME] [--model PROVIDER/MODEL] [--variant VARIANT] [--permission-mode deny-all|approve-reads|approve-all] [--permission-policy-file PRIVATE_FILE]\nopencode-task status TASK_ID\nopencode-task result TASK_ID\nopencode-task cancel TASK_ID\nopencode-task recover\nopencode-task resolve TASK_ID --status success|error|cancelled --output-file FILE\nResult output is bounded assistant text; timing is local Unix epoch milliseconds. It does not verify Git, tests or other claims in that text. Env profile defaults to codex/gpt-6.1-sol, max. A named session fixes model/variant/config; conflicts require a new session. Callback registration JSON is read from stdin unless --callback-file is supplied. No callback values in arguments or environment. Permission overrides require existing user authorization for this task; no automatic escalation.";

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
  let runtime;
  const runner = new TaskRunner({
    root: path.join(root, "runtime/tasks"),
    policy: healthPolicy(process.env),
  });
  try {
    if (command === "submit") {
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
          throw error; // No accepted:true without a monitor acknowledgement.
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
        // The durable outbox is complete. Release both locks before monitor handoff.
        for (const lock of JSON.parse(process.env.OPENCODE_MODULE_TASK_LOCKS ?? "[]")) fs.closeSync(lock);
        delete process.env.OPENCODE_MODULE_TASK_LOCKS;
        await spawnWorker(id);
        console.log(JSON.stringify(runner.status(id)));
      } else if (command === "result") {
        if (args.length) throw new Error("INVALID_ARGUMENTS");
        console.log(JSON.stringify(runner.result(id)));
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
  await main();
} catch (error) {
  // No raw exception, request, environment, response body, or callback is printable.
  console.error(
    ["SESSION_MODEL_CONFLICT", "SUBMIT_CONFLICT", "SESSION_CWD_CONFLICT"].includes(error.message)
      ? `${error.message}: use the original intent or a new key/session.`
      : "opencode-task failed; check command syntax and private module task state.",
  );
  process.exitCode = 1;
}
// Pending transport/iterator promises cannot keep a finished driver alive.
if (["_worker", "_observe"].includes(command)) process.exit(process.exitCode ?? 0);

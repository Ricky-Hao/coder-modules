#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskRunner, privateFile } from "./task.mjs";
import { createTaskRuntime } from "./task-acp.mjs";

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
  "cancel",
  "recover",
  "resolve",
  "_worker",
]);
const help =
  "opencode-task submit --key KEY --prompt-file FILE [--callback-file PRIVATE_FILE] [--session NAME] [--model PROVIDER/MODEL] [--variant VARIANT] [--permission-mode deny-all|approve-reads|approve-all] [--permission-policy-file PRIVATE_FILE]\nopencode-task status TASK_ID\nopencode-task cancel TASK_ID\nopencode-task recover\nopencode-task resolve TASK_ID --status success|error|cancelled --output-file FILE\nEnv profile defaults to codex/gpt-6.1-sol, max. A named session fixes model/variant/config; conflicts require a new session. Callback registration JSON is read from stdin unless --callback-file is supplied. No callback values in arguments or environment. Permission overrides require existing user authorization for this task; no automatic escalation.";

function spawnWorker(id) {
  const child = spawn(path.join(root, "bin/opencode-task"), ["_worker", id], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {}); // The accepted record is recovered on startup/recover.
  child.unref();
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
      spawnWorker(accepted.task_id);
      console.log(JSON.stringify(accepted));
    } else if (command === "recover") {
      if (args.length) throw new Error("INVALID_ARGUMENTS");
      const pending = runner.pending();
      for (const id of pending) spawnWorker(id);
      console.log(JSON.stringify({ version: 1, recovering: pending.length }));
    } else {
      const id = args.shift();
      const stored = runner.load(id);
      if (command === "_worker" || command === "cancel") {
        runtime = createTaskRuntime(root, stored);
        runner.runtime = runtime;
      }
      if (command === "_worker") {
        if (args.length) throw new Error("INVALID_ARGUMENTS");
        await runner.execute(id);
        let record = runner.load(id);
        while (record.state === "outbox") {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, record.nextAttemptAt - Date.now())),
          );
          await runner.deliver(record);
          record = runner.load(id);
        }
      } else if (command === "resolve") {
        const flags = options(args, ["--status", "--output-file"]);
        if (!flags["--status"] || !flags["--output-file"])
          throw new Error("INVALID_ARGUMENTS");
        runner.resolve(
          id,
          flags["--status"],
          readBounded(flags["--output-file"], 32768),
        );
        spawnWorker(id);
        console.log(JSON.stringify(runner.status(id)));
      } else {
        if (args.length) throw new Error("INVALID_ARGUMENTS");
        if (command === "cancel") {
          await runner.cancel(id);
          spawnWorker(id);
        }
        console.log(JSON.stringify(runner.status(id)));
      }
    }
  } finally {
    await runtime?.shutdown();
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

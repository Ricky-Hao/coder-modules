import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createSharedAcpRuntime, createAgentRegistry } from "../scripts/node_modules/acpx/dist/runtime.js";
import { TaskStore } from "../scripts/task.mjs";
import { TaskWorker } from "../scripts/task-worker.mjs";
import { createTaskRuntime, cancelTask } from "../scripts/task-acp.mjs";
import { readyTask } from "./task-fixture.mjs";

test("pinned runtime: closeStream retains IPC/result, journal output and canonical failure, no owner-exit wait", { timeout: 30000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-thin-")); fs.chmodSync(base, 0o700);
  const previous = { ...process.env }; process.env.HOME = base; process.env.TASK_FIXTURE_LOG = path.join(base, "executions");
  const store = new TaskStore(base), runtimes = [], handles = [];
  const create = () => {
    const runtime = createSharedAcpRuntime({ cwd: base, permissionMode: "deny-all", nonInteractivePermissions: "deny", authPolicy: "skip", ttlMs: 10000,
      agentRegistry: createAgentRegistry({ overrides: { opencode: [process.execPath, fileURLToPath(new URL("./acp.fixture.mjs", import.meta.url))] } }) });
    runtimes.push(runtime); return runtime;
  };
  let closes = 0;
  try {
    for (const [key, prompt, expected] of [["first", "produce final answer", "Pinned ACP result"], ["slow", "long tool", "Slow tool completed"], ["failed", "provider failed", null]]) {
      const task = readyTask(store, { key, prompt }), runtime = create(), start = runtime.startTurn.bind(runtime);
      runtime.startTurn = (input) => {
        const turn = start(input), close = turn.closeStream.bind(turn);
        turn.closeStream = async () => { closes++; await close(); assert.equal((await turn.events.next()).done, true); };
        return turn;
      };
      const worker = new TaskWorker(store, { runtime, pollMs: 20 });
      const before = Date.now(); await worker.run(task, { deliver: false }); handles.push(task.handle);
      assert.ok(Date.now() - before < 9000); assert.equal(task.phase, "finished");
      const result = store.summary(task, { output: true });
      assert.equal(result.result_status, expected ? "success" : "error"); assert.equal(result.output_incomplete, false);
      if (expected) assert.equal(result.output, expected);
      else { assert.equal(result.execution_error.reason, "QUEUE_RUNTIME_PROMPT_FAILED"); assert.equal(JSON.stringify(task).includes("provider.internal"), false); }
    }
    assert.equal(closes, 3);
    const observer = create(), handle = handles[0], events = [];
    for await (const event of observer.watchSession({ handle, signal: AbortSignal.timeout(3000) })) {
      events.push(event.type); if (event.type === "turn_result") break;
    }
    assert.ok(events.includes("message")); assert.ok(events.includes("turn_started"));
    await assert.rejects(async () => {
      for await (const event of observer.watchSession({ handle, cursor: "invalid", signal: AbortSignal.timeout(1000) })) void event;
    }, (error) => error.code === "WATCH_CURSOR_INVALID");
    assert.equal(fs.readFileSync(process.env.TASK_FIXTURE_LOG, "utf8").trim().split("\n").length, 3);
  } finally {
    const cleanup = create(); for (const handle of handles) await cleanup.close({ handle, reason: "fixture cleanup" }).catch(() => {});
    await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("pinned cancel: fixed socket/UID/generation and response identity; only original request", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-proof-")), previous = process.env.HOME; process.env.HOME = base;
  const digest = (value, count) => createHash("sha256").update(value).digest("hex").slice(0, count);
  const recordId = "synthetic-owner-record", queues = path.join(base, ".acpx/queues"), socketDir = `/tmp/acpx-${digest(base, 10)}`;
  fs.mkdirSync(queues, { recursive: true, mode: 0o700 }); fs.mkdirSync(socketDir, { mode: 0o700 });
  const socketPath = path.join(socketDir, digest(recordId, 24) + ".sock"), file = path.join(queues, digest(recordId, 24) + ".lock");
  const startTicks = fs.readFileSync("/proc/self/stat", "utf8").split(") ").at(-1).trim().split(/\s+/)[19];
  const owner = { sessionId: recordId, pid: process.pid, ownerGeneration: 1, queueDepth: 0,
    createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), socketPath,
    processIdentity: { kind: "linux-proc", bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      pidNamespace: fs.readlinkSync("/proc/self/ns/pid"), timeNamespace: fs.readlinkSync("/proc/self/ns/time"), startTicks } };
  fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 }); const before = fs.readFileSync(file), received = []; let generation = 1;
  const server = net.createServer((socket) => socket.on("data", (data) => {
    const message = JSON.parse(data); received.push(message);
    socket.end(JSON.stringify({ type: "cancel_result", requestId: message.requestId, ownerGeneration: generation, cancelled: true }) + "\n");
  }));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const record = { cwd: base, sessionKey: "original-session", requestId: "original-request", permissions: { mode: "deny-all", policy: {} },
    model: { id: "fixture/test" }, modelConfig: "/missing-config", modelProfile: "external",
    handle: { backend: "acpx-shared", cwd: base, sessionKey: "original-session", acpxRecordId: recordId } };
  const runtime = createTaskRuntime(base, record);
  try {
    assert.equal(await cancelTask(record), true); generation = 2;
    await assert.rejects(cancelTask(record), /CANCEL_UNCONFIRMED/);
    await assert.rejects(runtime.cancelRequest({ handle: record.handle, requestId: "other" }), /SESSION_IDENTITY_CONFLICT/);
    assert.throws(() => cancelTask({ ...record, requestId: undefined }), /SESSION_IDENTITY_CONFLICT/);
    fs.writeFileSync(file, JSON.stringify({ ...owner, socketPath: "/untrusted/socket" }));
    await assert.rejects(cancelTask(record), /UNSAFE_OWNER_SOCKET/); fs.writeFileSync(file, before);
    assert.equal(received.length, 2); assert.ok(received.every((message) => message.type === "cancel_prompt" && message.targetRequestId === record.requestId));
    assert.deepEqual(fs.readFileSync(file), before);
  } finally {
    await runtime.shutdown(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(socketDir, { recursive: true }); fs.rmSync(base, { recursive: true });
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
  }
});

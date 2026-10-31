import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createSharedAcpRuntime,
  createAgentRegistry,
} from "../scripts/node_modules/acpx/dist/runtime.js";
import { TaskRunner } from "../scripts/task.mjs";
import { createTaskRuntime } from "../scripts/task-acp.mjs";
import net from "node:net";
import { createHash } from "node:crypto";

test(
  "pinned acpx shared runtime: turn.result, passive watch(requestId,cursor), cancel, no owner-exit wait",
  { timeout: 30000 },
  async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-acp-"));
    fs.chmodSync(base, 0o700);
    process.env.HOME = base;
    process.env.TASK_FIXTURE_LOG = path.join(base, "executions");
    const taskRoot = path.join(base, "tasks");
    fs.mkdirSync(taskRoot, { mode: 0o700 });
    const options = {
      cwd: base,
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      authPolicy: "skip",
      ttlMs: 10000,
      agentRegistry: createAgentRegistry({
        overrides: {
          opencode: [
            process.execPath,
            fileURLToPath(new URL("./acp.fixture.mjs", import.meta.url)),
          ],
        },
      }),
    };
    const first = createSharedAcpRuntime(options);
    let second;
    let handle;
    try {
      const runner = new TaskRunner({ root: taskRoot, runtime: first });
      const accepted = runner.submit({
        model: { id: 'fixture/test' }, modelConfig: path.join(base, 'config.json'), modelProfile: 'external',
        key: "real-acpx-fixture",
        cwd: base,
        prompt: "produce final answer",
        callback: {
          callback_id: `tcb_${"y".repeat(43)}`,
          callback_url: "http://127.0.0.1:1/api/agents/task-callbacks",
        },
      });
      const start = Date.now();
      await runner.execute(accepted.task_id);
      assert.ok(
        Date.now() - start < 9000,
        "Must finish before the 10-second idle owner TTL",
      );
      const record = runner.load(accepted.task_id);
      handle = record.handle;
      assert.equal(record.state, "completed");
      assert.equal(JSON.parse(record.body).output, "Pinned ACP result");
      await first.shutdown();
      second = createSharedAcpRuntime(options);
      assert.ok(
        await second.findSession({
          sessionKey: record.sessionKey,
          agent: "opencode",
          cwd: base,
        }),
      );
      let cursor;
      const events = [];
      const signal = AbortSignal.timeout(5000);
      for await (const event of second.watchSession({ handle, signal })) {
        if (event.requestId !== record.requestId) continue;
        events.push(event.type);
        cursor = event.cursor;
        if (event.type === "turn_result") {
          assert.equal(event.result.status, "completed");
          break;
        }
      }
      assert.ok(events.includes("turn_started"));
      assert.ok(events.includes("message"));
      const cancelled = second.startTurn({
        handle,
        requestId: "cancel-this-request",
        text: "wait for cancellation",
        mode: "prompt",
      });
      await cancelled.promptStarted;
      await cancelled.cancel();
      assert.equal((await cancelled.result).status, "cancelled");
      const resumed = [];
      for await (const event of second.watchSession({
        handle,
        cursor,
        signal: AbortSignal.timeout(5000),
      })) {
        if (event.requestId === "cancel-this-request") resumed.push(event.type);
        if (
          event.type === "turn_result" &&
          event.requestId === "cancel-this-request"
        )
          break;
      }
      assert.ok(resumed.includes("turn_result"));
      assert.equal(
        fs
          .readFileSync(path.join(base, "executions"), "utf8")
          .trim()
          .split("\n").length,
        2,
      );
      const slowRunner = new TaskRunner({ root: taskRoot, runtime: second,
        pollMs: 100, noProgressMs: 5000 });
      const slow = slowRunner.submit({ model: { id: 'fixture/test' }, modelConfig: path.join(base, 'config.json'), modelProfile: 'external',
        key: 'real-slow-tool', cwd: base, prompt: 'long tool', callback: {
        callback_id: `tcb_${'a'.repeat(43)}`, callback_url: 'http://127.0.0.1:1/api/agents/task-callbacks' } });
      await slowRunner.execute(slow.task_id);
      const slowRecord = slowRunner.load(slow.task_id);
      assert.equal(slowRecord.state, 'completed');
      assert.equal(slowRunner.result(slow.task_id).output, 'Slow tool completed');
      await second.close({ handle: slowRecord.handle, reason: 'slow fixture cleanup' });
    } finally {
      if (handle)
        await (second ?? first)
          .close({ handle, reason: "fixture cleanup" })
          .catch(() => {});
      await second?.shutdown();
      await first.shutdown();
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);

test('pinned cancel adapter checks socket and generation, only sends target request and leaves owner bytes unchanged', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-proof-'));
  const previous = process.env.HOME;
  process.env.HOME = base;
  try {
    const recordId = 'synthetic-owner-record';
    const queues = path.join(base, '.acpx/queues');
    fs.mkdirSync(queues, { recursive: true, mode: 0o700 });
    const file = path.join(queues, createHash('sha256').update(recordId).digest('hex').slice(0, 24) + '.lock');
    const startTicks = fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).trim().split(/\s+/)[19];
    const proof = { kind: 'linux-proc', bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      pidNamespace: fs.readlinkSync('/proc/self/ns/pid'), timeNamespace: fs.readlinkSync('/proc/self/ns/time'), startTicks };
    const digest = (text, length) => createHash('sha256').update(text).digest('hex').slice(0, length);
    const socketDir = `/tmp/acpx-${digest(base, 10)}`;
    fs.mkdirSync(socketDir, { mode: 0o700 });
    const socketPath = `${socketDir}/${digest(recordId, 24)}.sock`;
    const owner = { sessionId: recordId, pid: process.pid, ownerGeneration: 1, queueDepth: 0,
      createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      socketPath, processIdentity: proof };
    fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 });
    const before = fs.readFileSync(file), received = [];
    let generation = 1;
    const server = net.createServer((socket) => socket.on('data', (data) => {
      const message = JSON.parse(data.toString()); received.push(message);
      socket.end(JSON.stringify({ type: 'cancel_result', requestId: message.requestId, ownerGeneration: generation, cancelled: true }) + '\n');
    }));
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const config = path.join(base, 'config.json'); fs.writeFileSync(config, '{}', { mode: 0o600 });
    const record = { cwd: base, sessionKey: 'cancel-session', requestId: 'original-request', permissions: { mode: 'deny-all', policy: {} },
      model: { id: 'fixture/test' }, modelConfig: config, modelProfile: 'external' };
    const runtime = createTaskRuntime(base, record);
    const handle = { backend: 'acpx-shared', cwd: base, sessionKey: record.sessionKey, acpxRecordId: recordId };
    try {
      assert.equal(await runtime.cancelRequest({ handle, requestId: record.requestId }), true);
      generation = 2;
      await assert.rejects(runtime.cancelRequest({ handle, requestId: record.requestId }), /CANCEL_UNCONFIRMED/);
      await assert.rejects(runtime.cancelRequest({ handle, requestId: 'someone-else' }), /SESSION_IDENTITY_CONFLICT/);
      fs.writeFileSync(file, JSON.stringify({ ...owner, socketPath: '/untrusted/socket' }));
      await assert.rejects(runtime.cancelRequest({ handle, requestId: record.requestId }), /UNSAFE_OWNER_SOCKET/);
      fs.writeFileSync(file, before);
      assert.equal(received.length, 2);
      assert.ok(received.every((value) => value.type === 'cancel_prompt' && value.targetRequestId === record.requestId));
      assert.deepEqual(fs.readFileSync(file), before);
    } finally {
      await runtime.shutdown(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(socketDir, { recursive: true });
    }
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

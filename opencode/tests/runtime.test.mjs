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
import { observeOwner } from "../scripts/task-acp.mjs";
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
      assert.equal(record.state, "outbox");
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
      second.observeOwner = ({ handle }) => observeOwner(handle.acpxRecordId);
      second.journalAuthoritative = true;
      const slowRunner = new TaskRunner({ root: taskRoot, runtime: second,
        policy: { ...runner.policy, pollMs: 100, discoveryMs: 5000, probeMs: 500, confirmMs: 200, progressMs: 500, toolMs: 5000 } });
      const slow = slowRunner.submit({ key: 'real-slow-tool', cwd: base, prompt: 'long tool', callback: {
        callback_id: `tcb_${'a'.repeat(43)}`, callback_url: 'http://127.0.0.1:1/api/agents/task-callbacks' } });
      await slowRunner.execute(slow.task_id);
      const slowRecord = slowRunner.load(slow.task_id);
      assert.equal(slowRecord.state, 'outbox', JSON.stringify({ health: slowRecord.health, error: slowRecord.executionError }));
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

test('owner observation is read-only, rejects stale heartbeat and reused PID birth identity', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-proof-'));
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
    const owner = { sessionId: recordId, pid: process.pid, ownerGeneration: 1, queueDepth: 0,
      createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
      socketPath: '/synthetic/no-socket', processIdentity: proof };
    const inspect = async (value) => {
      fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      const before = fs.readFileSync(file);
      const observed = await observeOwner(recordId);
      assert.deepEqual(fs.readFileSync(file), before);
      return observed;
    };
    assert.equal((await inspect(owner)).owner, 'lease_current');
    assert.equal((await inspect({ ...owner, heartbeatAt: new Date(Date.now() - 60000).toISOString() })).owner, 'unavailable');
    assert.equal((await inspect({ ...owner, heartbeatAt: new Date(Date.now() + 60000).toISOString() })).owner, 'unavailable');
    const reused = await inspect({ ...owner, processIdentity: { ...proof, startTicks: String(BigInt(startTicks) + 1n) } });
    assert.equal(reused.process, 'gone');
    assert.equal(reused.owner, 'unavailable');
    const foreign = await inspect({ ...owner, processIdentity: { ...proof, pidNamespace: 'pid:[1]' } });
    assert.equal(foreign.process, 'unknown');
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

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

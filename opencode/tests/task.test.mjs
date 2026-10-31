import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import {
  TaskRunner,
  appendOutput,
  callbackBody,
  retryDelay,
  save,
  validateCallback,
  HEALTH_DEFAULTS,
  healthPolicy,
  delay,
  deliveryState,
  Confirmation,
} from "../scripts/task.mjs";
import { supervise } from "../scripts/task-supervisor.mjs";
import { EventEmitter } from "node:events";

const callback = {
  callback_id: `tcb_${"x".repeat(43)}`,
  callback_url: "http://127.0.0.1:1/api/agents/task-callbacks",
};
const shortPolicy = { ...HEALTH_DEFAULTS, pollMs: 10, probeMs: 20, discoveryMs: 90,
  setupMs: 60, workerMs: 120, confirmMs: 40, progressMs: 500, drainMs: 20 };
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-task-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true }));
  let executions = 0;
  let requestId;
  let clock = 1000;
  const runtime = {
    async ensureSession(input) {
      return {
        sessionKey: input.sessionKey,
        cwd: input.cwd,
        acpxRecordId: "fixture-record",
        backend: "acpx-shared",
        backendSessionId: "fixture-session",
        runtimeSessionName: "fixture",
      };
    },
    startTurn(input) {
      executions++;
      requestId = input.requestId;
      assert.equal(input.text.includes(callback.callback_id), false);
      return {
        promptStarted: Promise.resolve(),
        events: (async function* () {
          yield {
            type: "text_delta",
            stream: "thought",
            text: "private thought",
          };
          yield {
            type: "text_delta",
            stream: "output",
            messageId: "intermediate",
            text: "Working...",
          };
          yield {
            type: "text_delta",
            stream: "output",
            messageId: "final",
            text: "Done ✓",
          };
        })(),
        result: Promise.resolve({ status: options.result ?? "completed" }),
      };
    },
    async *watchSession(input) {
      for (const event of options.journal ?? []) yield event;
      if (requestId && options.result === "failed")
        yield { type: "turn_result", requestId, result: { status: "failed" }, cursor: "failure" };
    },
    async cancel() {},
  };
  const runner = new TaskRunner({
    root,
    runtime,
    now: () => clock,
    fetcher: options.fetcher,
    policy: options.policy ?? shortPolicy,
  });
  const accepted = runner.submit({
    key: "local-submit-key",
    cwd: root,
    prompt: "Perform the task.",
    callback: options.callback ?? callback,
  });
  return {
    root,
    runner,
    runtime,
    id: accepted.task_id,
    accepted,
    executions: () => executions,
    advance: (ms) => {
      clock += ms;
    },
  };
}
const ok = () =>
  new Response(
    JSON.stringify({
      version: 1,
      receipt_id: "receipt",
      accepted_at: "2026-10-20T00:00:00Z",
    }),
    { status: 202 },
  );

for (const [result, status] of [
  ["completed", "success"],
  ["failed", "error"],
  ["cancelled", "cancelled"],
]) {
  test(`terminal ${status} result sealed before POST; persistent owner lifetime is irrelevant`, async (t) => {
    const f = fixture(t, {
      result,
      fetcher: async (_url, init) => {
        const onDisk = f.runner.load(f.id);
        assert.equal(onDisk.body, init.body);
        assert.equal(onDisk.state, "outbox");
        assert.equal(init.redirect, "manual");
        assert.equal(init.headers.Authorization, undefined);
        assert.deepEqual(
          JSON.parse(init.body),
          callbackBody(callback, status, status === "error"
            ? "Original request failed (REQUEST_FAILED). Side effects may have occurred; verify before retrying." : "Done ✓"),
        );
        return ok();
      },
    });
    await f.runner.execute(f.id);
    assert.equal(f.runner.load(f.id).state, "outbox");
    await f.runner.deliver(f.runner.load(f.id));
    assert.equal(f.runner.status(f.id).state, "delivered");
    assert.equal(f.executions(), 1);
    assert.equal(
      JSON.stringify(f.runner.status(f.id)).includes(callback.callback_id),
      false,
    );
  });
}

test("bounded result projection separates lifecycle and callback evidence", async (t) => {
  const f = fixture(t, { fetcher: async () => ok() });
  f.advance(10);
  await f.runner.execute(f.id);
  let summary = f.runner.result(f.id);
  assert.equal(summary.task_id, f.id);
  assert.equal(summary.request_id, f.runner.load(f.id).requestId);
  assert.equal(summary.session_key, f.runner.load(f.id).sessionKey);
  assert.equal(summary.session_id, "fixture-session");
  assert.equal(summary.acpx_record_id, "fixture-record");
  assert.equal(summary.state, "outbox");
  assert.equal(summary.result_status, "success");
  assert.equal(summary.output, "Done ✓");
  assert.equal(summary.output_bytes, 8);
  assert.equal(summary.output_limit_bytes, 32768);
  assert.equal(summary.output_truncated, false);
  assert.deepEqual(summary.timing, {
    time_basis: "unix_epoch_ms_wall_clock",
    accepted_at: 1000,
    started_at: 1010,
    terminal_at: 1010,
    callback_attempted_at: null,
    callback_delivered_at: null,
    supervision_failed_at: null,
  });
  assert.deepEqual(summary.evidence, {
    lifecycle: "program_observed",
    terminal_source: "turn.result",
    output_source: "assistant_output",
    callback_receipt: null,
  });
  assert.equal(JSON.stringify(summary).includes(callback.callback_id), false);
  assert.equal(JSON.stringify(summary).includes(callback.callback_url), false);
  assert.equal(JSON.stringify(f.runner.status(f.id)).includes(callback.callback_id), false);
  const taskFile = f.runner.filename(f.id);
  const beforeRead = fs.readFileSync(taskFile);
  f.runner.result(f.id);
  assert.deepEqual(fs.readFileSync(taskFile), beforeRead);

  f.advance(20);
  await f.runner.deliver(f.runner.load(f.id));
  summary = f.runner.result(f.id);
  assert.equal(summary.state, "delivered");
  assert.equal(summary.timing.callback_attempted_at, 1030);
  assert.equal(summary.timing.callback_delivered_at, 1030);
  assert.deepEqual(summary.evidence.callback_receipt, {
    receipt_id: "receipt",
    accepted_at: "2026-10-20T00:00:00Z",
  });
});

test("result projection reports the effective byte bound and truncation", async (t) => {
  const f = fixture(t, {
    callback: {
      ...callback,
      max_output_bytes: 3,
    },
    fetcher: async () => ok(),
  });
  await f.runner.execute(f.id);
  const summary = f.runner.result(f.id);
  assert.equal(summary.output, "Don");
  assert.equal(summary.output_bytes, 3);
  assert.equal(summary.output_limit_bytes, 3);
  assert.equal(summary.output_truncated, true);
  assert.ok(Buffer.byteLength(summary.output) <= summary.output_limit_bytes);
});

test("legacy result records report missing timing and source as unknown", async (t) => {
  const f = fixture(t, { fetcher: async () => ok() });
  await f.runner.execute(f.id);
  await f.runner.deliver(f.runner.load(f.id));
  const legacy = f.runner.load(f.id);
  for (const field of [
    "acceptedAt",
    "startedAt",
    "terminalAt",
    "callbackAttemptedAt",
    "callbackDeliveredAt",
    "terminalSource",
    "outputSource",
    "outputTruncated",
  ])
    delete legacy[field];
  f.runner.write(legacy);
  const taskFile = f.runner.filename(f.id);
  const beforeRead = fs.readFileSync(taskFile);
  const summary = f.runner.result(f.id);
  assert.deepEqual(summary.timing, {
    time_basis: "unix_epoch_ms_wall_clock",
    accepted_at: 1000,
    started_at: null,
    terminal_at: null,
    callback_attempted_at: null,
    callback_delivered_at: null,
    supervision_failed_at: null,
  });
  assert.equal(summary.output, "Done ✓");
  assert.equal(summary.output_truncated, null);
  assert.equal(summary.evidence.terminal_source, null);
  assert.equal(summary.evidence.output_source, null);
  assert.equal(summary.evidence.callback_receipt.receipt_id, "receipt");
  assert.deepEqual(fs.readFileSync(taskFile), beforeRead);
  delete legacy.createdAt;
  delete legacy.handle.backendSessionId;
  f.runner.write(legacy);
  assert.equal(f.runner.result(f.id).timing.accepted_at, null);
  assert.equal(f.runner.result(f.id).session_id, null);
});

test("result never projects nonterminal prompt or live output", (t) => {
  const f = fixture(t);
  const record = f.runner.load(f.id);
  record.output = "Unsealed assistant text";
  record.secret = "synthetic-secret";
  for (const state of ["queued", "dispatching", "running", "ambiguous"]) {
    record.state = state;
    f.runner.write(record);
    const summary = f.runner.result(f.id);
    assert.equal(summary.output, null);
    assert.equal(summary.output_available, false);
    assert.equal(summary.result_status, null);
    assert.equal(summary.timing.started_at, null);
    for (const text of [record.prompt, record.output, record.secret, callback.callback_id, callback.callback_url]) {
      assert.equal(JSON.stringify(summary).includes(text), false);
      assert.equal(JSON.stringify(f.runner.status(f.id)).includes(text), false);
    }
  }
  assert.equal(f.executions(), 0);
});

test("stream and final message truncation survive seal and are reset for a new message", (t) => {
  const f = fixture(t);
  const record = f.runner.load(f.id);
  appendOutput(record, "✓".repeat(20000), "intermediate");
  assert.equal(record.outputTruncated, true);
  appendOutput(record, "Final", "final");
  assert.equal(record.outputTruncated, false);
  appendOutput(record, "✓".repeat(20000), "final");
  assert.equal(record.outputTruncated, true);
  f.runner.seal(record, "success", record.output);
  const summary = f.runner.result(f.id);
  assert.equal(summary.output_truncated, true);
  assert.ok(summary.output_bytes <= 32768);
  assert.equal(summary.output.endsWith("\uFFFD"), false);
});

test("result clipping is explicit even for legacy or inconsistent truncation metadata", async (t) => {
  const f = fixture(t);
  await f.runner.execute(f.id);
  const record = f.runner.load(f.id);
  record.callback.max_output_bytes = 4;
  record.body = JSON.stringify(callbackBody(callback, "success", "✓✓"));
  for (const truncated of [false, undefined]) {
    record.outputTruncated = truncated;
    f.runner.write(record);
    const beforeRead = fs.readFileSync(f.runner.filename(f.id));
    const summary = f.runner.result(f.id);
    assert.equal(summary.output, "✓");
    assert.equal(summary.output_bytes, 3);
    assert.equal(summary.output_limit_bytes, 4);
    assert.equal(summary.output_truncated, true);
    assert.deepEqual(fs.readFileSync(f.runner.filename(f.id)), beforeRead);
  }
});

test("result withholds callback-shaped output and fails safely on malformed metadata", async (t) => {
  const f = fixture(t);
  await f.runner.execute(f.id);
  const sealed = f.runner.load(f.id);
  for (const text of [callback.callback_id, callback.callback_url, `tcb_${"y".repeat(43)}`]) {
    const record = structuredClone(sealed);
    record.callback.max_output_bytes = 6;
    record.body = JSON.stringify(callbackBody(callback, "success", text));
    f.runner.write(record);
    const beforeRead = fs.readFileSync(f.runner.filename(f.id));
    const summary = f.runner.result(f.id);
    assert.equal(summary.output, null);
    assert.equal(summary.output_available, false);
    assert.equal(summary.output_error, "PRIVATE_CALLBACK_CONTENT");
    assert.equal(JSON.stringify(summary).includes(text), false);
    assert.deepEqual(fs.readFileSync(f.runner.filename(f.id)), beforeRead);
  }
  const malformed = [
    { callback: { ...sealed.callback, max_output_bytes: 32769 } },
    { callback: { ...sealed.callback, max_output_bytes: 0 } },
    { callback: { ...sealed.callback, max_output_bytes: "100" } },
    { callback: null },
    { state: { prompt: sealed.prompt } },
    { requestId: { secret: callback.callback_id } },
    { sessionName: callback.callback_id },
    { terminalSource: callback.callback_url },
    { notificationKind: callback.callback_id },
    { outputSource: { prompt: sealed.prompt } },
    { receipt: { version: 1, receipt_id: callback.callback_id, accepted_at: "2026-10-20T00:00:00Z" } },
    { body: { secret: callback.callback_id } },
    { body: callback.callback_id },
    { body: JSON.stringify({ version: 1, callback_id: "wrong", status: "success", output: "text" }) },
    { body: JSON.stringify({ version: 1, callback_id: callback.callback_id, status: "success", output: { prompt: sealed.prompt } }) },
  ];
  for (const change of malformed) {
    f.runner.write({ ...structuredClone(sealed), ...change });
    const beforeRead = fs.readFileSync(f.runner.filename(f.id));
    assert.throws(() => f.runner.result(f.id), { message: "INVALID_TASK_RESULT" });
    assert.deepEqual(fs.readFileSync(f.runner.filename(f.id)), beforeRead);
  }
});

test("old outbox recovery preserves exact sealed bytes and does not invent lifecycle times", async (t) => {
  const bodies = [];
  const f = fixture(t, { fetcher: async (_url, init) => { bodies.push(init.body); return ok(); } });
  await f.runner.execute(f.id);
  const legacy = f.runner.load(f.id);
  legacy.body = JSON.stringify(JSON.parse(legacy.body), null, 2) + "\n";
  for (const field of ["createdAt", "startedAt", "terminalAt", "terminalSource", "outputSource", "outputTruncated"])
    delete legacy[field];
  f.runner.write(legacy);
  f.advance(5000);
  f.runner.seal(legacy, "error", "Must never replace sealed text");
  await f.runner.execute(f.id);
  await f.runner.deliver(f.runner.load(f.id));
  const summary = f.runner.result(f.id);
  assert.deepEqual(bodies, [legacy.body]);
  assert.equal(f.runner.load(f.id).body, legacy.body);
  assert.equal(summary.output, "Done ✓");
  assert.equal(summary.timing.accepted_at, null);
  assert.equal(summary.timing.started_at, null);
  assert.equal(summary.timing.terminal_at, null);
  assert.equal(summary.timing.callback_attempted_at, 6000);
  assert.equal(summary.timing.callback_delivered_at, 6000);
  assert.equal(f.executions(), 1);
});

test("lost receipt and restart retry identical bytes without executing again; Retry-After respected", async (t) => {
  const bodies = [];
  const f = fixture(t, {
    fetcher: async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length === 1) throw new Error("lost response");
      if (bodies.length === 2)
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      return ok();
    },
  });
  await f.runner.execute(f.id);
  const terminalAt = f.runner.result(f.id).timing.terminal_at;
  await f.runner.deliver(f.runner.load(f.id));
  assert.equal(f.runner.load(f.id).state, "outbox");
  assert.equal(f.runner.result(f.id).timing.callback_delivered_at, null);
  f.advance(10000);
  const restarted = new TaskRunner({
    root: f.root,
    runtime: f.runtime,
    now: () => 11000,
    fetcher: f.runner.fetcher,
  });
  await restarted.execute(f.id);
  await restarted.deliver(restarted.load(f.id));
  assert.equal(restarted.load(f.id).nextAttemptAt, 71000);
  assert.equal(restarted.result(f.id).timing.terminal_at, terminalAt);
  assert.equal(restarted.result(f.id).timing.callback_attempted_at, 11000);
  f.advance(100000);
  await f.runner.deliver(f.runner.load(f.id));
  assert.equal(f.runner.status(f.id).state, "delivered");
  assert.equal(new Set(bodies).size, 1);
  assert.equal(f.executions(), 1);
});

test("submit replay dedupes locally and changed payload conflicts", async (t) => {
  const f = fixture(t);
  const replay = f.runner.submit({
    key: "local-submit-key",
    cwd: f.root,
    prompt: "Perform the task.",
    callback,
  });
  assert.deepEqual(replay, f.accepted);
  assert.equal(f.runner.result(f.id).timing.accepted_at, 1000);
  assert.throws(
    () =>
      f.runner.submit({
        key: "local-submit-key",
        cwd: f.root,
        prompt: "Changed",
        callback,
      }),
    /SUBMIT_CONFLICT/,
  );
  await f.runner.execute(f.id);
  await f.runner.execute(f.id);
  assert.equal(f.executions(), 1);
});

test("permissions and shared cwd/session are immutable submit identity", async (t) => {
  const f = fixture(t);
  const common = {
    key: "authorized-run",
    cwd: f.root,
    prompt: "Perform authorized edits.",
    callback,
    session: "review-branch",
    permissionMode: "approve-all",
    permissionPolicy: { autoDeny: ["delete"] },
  };
  const first = f.runner.submit(common);
  assert.deepEqual(f.runner.submit(common), first);
  assert.throws(
    () => f.runner.submit({ ...common, permissionMode: "deny-all" }),
    /SUBMIT_CONFLICT/,
  );
  const next = f.runner.submit({
    ...common,
    key: "review-run",
    callback: { ...callback, callback_id: `tcb_${"b".repeat(43)}` },
  });
  assert.notEqual(first.request_id, next.request_id);
  const original = f.runner.load(first.task_id);
  const followup = f.runner.load(next.task_id);
  assert.equal(original.sessionKey, followup.sessionKey);
  assert.deepEqual(original.permissions, {
    mode: "approve-all",
    policy: { autoDeny: ["delete"] },
  });
  const other = path.join(f.root, "other-cwd");
  fs.mkdirSync(other, { mode: 0o700 });
  assert.throws(
    () => f.runner.submit({ ...common, key: "cross-cwd", cwd: other }),
    /SESSION_CWD_CONFLICT/,
  );
  assert.throws(
    () =>
      f.runner.submit({
        ...common,
        key: "invalid-mode",
        permissionMode: "automatic",
      }),
    /INVALID_PERMISSIONS/,
  );
});

test("model intent binds dedupe/session and survives recovery; old records stay readable", async (t) => {
  const f = fixture(t);
  const common = { key: 'model-intent', prompt: 'Perform the task.', cwd: f.root, callback,
    model: { id: 'copilot/gpt-6-astra', variant: 'high' }, modelConfig: path.join(f.root, 'immutable.json') };
  const accepted = f.runner.submit(common);
  assert.deepEqual(f.runner.submit(common), accepted);
  for (const change of [{ model: { id: 'codex/gpt-6-astra', variant: 'high' } },
    { model: { id: 'copilot/gpt-6-astra', variant: 'max' } }, { modelConfig: path.join(f.root, 'changed.json') }])
    assert.throws(() => f.runner.submit({ ...common, ...change }), /SUBMIT_CONFLICT/);
  const named = f.runner.submit({ ...common, key: 'named-model', session: 'fixed' });
  assert.throws(() => f.runner.submit({ ...common, key: 'changed-named', session: 'fixed',
    model: { id: 'codex/gpt-6.1-sol', variant: 'max' } }), /SESSION_MODEL_CONFLICT/);
  const record = f.runner.load(accepted.task_id);
  assert.deepEqual(record.model, common.model);
  const ensure = f.runtime.ensureSession;
  f.runtime.ensureSession = async (input) => {
    assert.deepEqual(input.model, common.model); throw new Error('selection refused before prompt');
  };
  await f.runner.execute(accepted.task_id);
  assert.equal(f.executions(), 0);
  assert.equal(f.runner.status(accepted.task_id).execution_error, 'MODEL_OR_SESSION_SETUP_FAILED');
  assert.equal(f.runner.status(accepted.task_id).state, 'outbox');
  assert.equal(f.runner.result(accepted.task_id).evidence.terminal_source, 'execution_setup_failure');
  f.runtime.ensureSession = ensure;
  await f.runner.execute(accepted.task_id);
  assert.equal(f.executions(), 0);
  const completed = f.runner.load(accepted.task_id);
  const recovered = new TaskRunner({ root: f.root, runtime: f.runtime });
  await recovered.execute(accepted.task_id);
  assert.deepEqual(recovered.load(accepted.task_id), completed);
  assert.equal(f.executions(), 0);
  assert.deepEqual(recovered.load(named.task_id).model, common.model);
  // The original fixture record has no selection fields or new fingerprint inputs.
  const legacy = f.runner.load(f.id);
  assert.equal(legacy.model, undefined);
  await recovered.execute(f.id);
  assert.equal(recovered.load(f.id).model, undefined);
  f.runner.submit({ key: 'legacy-session', prompt: 'old request', cwd: f.root, callback, session: 'legacy' });
  const sessionFile = fs.readdirSync(path.join(f.root, '.sessions')).filter((name) => name !== 'owner.json')
    .map((name) => path.join(f.root, '.sessions', name)).find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).name === 'legacy');
  const before = fs.readFileSync(sessionFile);
  assert.throws(() => f.runner.submit({ ...common, key: 'no-adoption', session: 'legacy' }), /SESSION_MODEL_CONFLICT/);
  assert.deepEqual(fs.readFileSync(sessionFile), before);
});

test("cancellation targets only the stored request; mismatched handles fail closed", async (t) => {
  const f = fixture(t);
  const record = f.runner.load(f.id);
  record.state = "running";
  record.handle = await f.runtime.ensureSession({
    sessionKey: record.sessionKey,
    cwd: record.cwd,
  });
  f.runner.write(record);
  let targeted;
  f.runtime.cancelRequest = async (input) => {
    targeted = input;
  };
  f.runtime.cancel = async () => {
    throw new Error("Session-wide cancel is forbidden");
  };
  await f.runner.cancel(f.id);
  assert.equal(targeted.requestId, record.requestId);
  record.handle.cwd = "/another-cwd";
  f.runner.write(record);
  await assert.rejects(f.runner.execute(f.id), /SESSION_IDENTITY_CONFLICT/);
});

test("journal recovery matches original requestId and saves output with cursor; never replays", async (t) => {
  const f = fixture(t);
  const record = f.runner.load(f.id);
  record.state = "dispatching";
  record.handle = await f.runtime.ensureSession({
    sessionKey: record.sessionKey,
    cwd: record.cwd,
  });
  f.runner.write(record);
  let cursor;
  f.runtime.watchSession = async function* (input) {
    cursor = input.cursor;
    if (input.cursor === "2") throw new Error("still unavailable");
    yield {
      type: "turn_result",
      requestId: "someone-else",
      cursor: "1",
      result: { status: "completed" },
    };
    assert.equal(f.runner.result(f.id).timing.started_at, null);
    yield {
      type: "message",
      requestId: record.requestId,
      cursor: "2",
      message: {
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "final",
            content: { type: "text", text: "Recovered" },
          },
        },
      },
    };
    throw new Error("owner temporarily unavailable");
  };
  await f.runner.execute(f.id);
  assert.equal(f.runner.status(f.id).state, "ambiguous");
  assert.equal(f.runner.load(f.id).cursor, "2");
  assert.equal(f.runner.result(f.id).timing.started_at, null);
  f.runtime.watchSession = async function* (input) {
    cursor = input.cursor;
    yield {
      type: "turn_result",
      requestId: record.requestId,
      cursor: "3",
      result: { status: "completed" },
    };
  };
  await f.runner.execute(f.id);
  assert.equal(cursor, "2");
  assert.equal(JSON.parse(f.runner.load(f.id).body).output, "Recovered");
  assert.equal(f.runner.result(f.id).timing.started_at, null);
  assert.equal(f.runner.result(f.id).evidence.terminal_source, "watchSession.turn_result");
  assert.equal(f.executions(), 0);
});

test("uncertain dispatch remains explicit; resolve seals only verified operator output", async (t) => {
  const f = fixture(t);
  f.runtime.startTurn = () => {
    throw new Error("uncertain");
  };
  await f.runner.execute(f.id);
  assert.equal(f.runner.status(f.id).state, "ambiguous");
  await f.runner.execute(f.id);
  assert.equal(f.runner.status(f.id).state, "ambiguous");
  f.runner.resolve(f.id, "error", "Verified interrupted result");
  assert.equal(f.runner.status(f.id).state, "outbox");
  assert.equal(f.runner.result(f.id).evidence.terminal_source, "operator_resolution");
  assert.equal(f.runner.result(f.id).evidence.output_source, "operator_verified");
  assert.throws(
    () => f.runner.resolve(f.id, "success", "different"),
    /TASK_NOT_AMBIGUOUS/,
  );
});

test("cancel queued task never dispatches; bounded UTF-8 output and input guards", async (t) => {
  const f = fixture(t);
  await f.runner.cancel(f.id);
  await f.runner.execute(f.id);
  assert.equal(f.runner.status(f.id).result_status, "cancelled");
  assert.equal(f.runner.result(f.id).timing.started_at, null);
  assert.equal(f.runner.result(f.id).evidence.terminal_source, "queued_cancellation");
  assert.equal(f.runner.result(f.id).evidence.output_source, "program_generated");
  assert.equal(f.executions(), 0);
  assert.ok(
    Buffer.byteLength(
      callbackBody(callback, "success", "✓".repeat(20000)).output,
    ) <= 32768,
  );
  assert.throws(
    () =>
      f.runner.submit({
        key: "other",
        cwd: f.root,
        prompt: callback.callback_id,
        callback,
      }),
    /CALLBACK_IN_PROMPT/,
  );
  for (const url of [
    "http://example.test/api/agents/task-callbacks",
    "https://a.test/path?secret=x",
    "https://user:pass@a.test/api/agents/task-callbacks",
  ]) {
    assert.throws(
      () => validateCallback({ ...callback, callback_url: url }),
      /INVALID_CALLBACK/,
    );
  }
});

test("local HTTP redirect cannot leak bearer to another server", async (t) => {
  let received = 0;
  const target = http.createServer((_req, res) => {
    received++;
    res.end();
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const source = http.createServer((_req, res) => {
    res.writeHead(307, {
      Location: `http://127.0.0.1:${target.address().port}`,
    });
    res.end();
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    target.close();
    source.close();
  });
  const f = fixture(t);
  const record = f.runner.load(f.id);
  record.callback.callback_url = `http://127.0.0.1:${source.address().port}/api/agents/task-callbacks`;
  f.runner.write(record);
  await f.runner.execute(f.id);
  await f.runner.deliver(f.runner.load(f.id));
  assert.equal(received, 0);
  assert.equal(f.runner.status(f.id).delivery_error, "REDIRECT_REFUSED");
});

test("refuses unsafe task file and preserves unrelated sibling/session content", (t) => {
  const f = fixture(t);
  const sentinel = path.join(f.root, "sibling");
  fs.writeFileSync(sentinel, "preserved");
  fs.chmodSync(f.runner.filename(f.id), 0o644);
  assert.throws(() => f.runner.load(f.id), /UNSAFE_TASK_FILE/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserved");
  assert.equal(retryDelay(99, "1", 0), 300000);
});

const never = () => new Promise(() => {});
const connected = async () => ({ owner: "lease_current", process: "alive", generation: 1 });

test("setup timeout seals a safe error without dispatch or replay", { timeout: 2000 }, async (t) => {
  const f = fixture(t, { policy: shortPolicy });
  f.runtime.ensureSession = never;
  await f.runner.execute(f.id);
  assert.equal(f.runner.load(f.id).state, "outbox");
  assert.equal(f.runner.result(f.id).result_status, "error");
  assert.equal(f.runner.result(f.id).timing.started_at, null);
  await f.runner.execute(f.id);
  assert.equal(f.executions(), 0);
});

test("canonical failure seals even when events and promptStarted never finish; late started cannot overwrite it",
  { timeout: 2000 }, async (t) => {
    const f = fixture(t, { policy: shortPolicy });
    let started;
    f.runtime.startTurn = () => ({ promptStarted: new Promise((resolve) => { started = resolve; }),
      events: (async function* () { await never(); })(),
      result: Promise.resolve({ status: "failed", error: { code: "RUNTIME", message: "private synthetic error" } }) });
    f.runtime.watchSession = async function* () {
      yield { type: "turn_result", requestId: f.accepted.request_id, result: { status: "failed" }, cursor: "1" };
    };
    const began = Date.now();
    await f.runner.execute(f.id);
    const sealed = f.runner.load(f.id).body;
    started();
    await delay(10);
    assert.ok(Date.now() - began < 1000);
    assert.equal(f.runner.load(f.id).state, "outbox");
    assert.equal(f.runner.load(f.id).body, sealed);
    assert.equal(sealed.includes("private synthetic error"), false);
    assert.equal(f.runner.result(f.id).timing.started_at, null);
  });

test("matching original journal entry cannot disable liveness discovery; unknown notification preserves ambiguity and exact bytes",
  { timeout: 2000 }, async (t) => {
    const bodies = [];
    const f = fixture(t, { policy: shortPolicy, fetcher: async (_url, init) => { bodies.push(init.body); return ok(); } });
    const record = f.runner.load(f.id);
    record.state = "running";
    record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
    f.runner.write(record);
    f.runtime.watchSession = async function* () {
      yield { requestId: record.requestId, type: "turn_started", cursor: "original" };
      await never(); // Even an iterator ignoring AbortSignal must not retain the driver.
    };
    f.runtime.observeOwner = async () => ({ owner: "unavailable", process: "unknown" });
    await f.runner.execute(f.id);
    assert.equal(f.runner.status(f.id).state, "ambiguous");
    f.runner.fail(f.runner.load(f.id), "OWNER_UNAVAILABLE");
    await f.runner.deliver(f.runner.load(f.id));
    const summary = f.runner.result(f.id);
    assert.equal(summary.state, "ambiguous");
    assert.equal(summary.result_status, null);
    assert.equal(summary.callback_status, "error");
    assert.equal(summary.callback_state, "delivered");
    assert.equal(summary.callback_kind, "supervision_failure");
    assert.equal(summary.timing.terminal_at, null);
    assert.ok(summary.timing.supervision_failed_at);
    assert.match(summary.output, /side effects are unknown/);
    assert.equal(summary.health.automatic_retry, false);
    await f.runner.execute(f.id);
    assert.equal(f.executions(), 0);
    assert.equal(f.runner.load(f.id).body, bodies[0]);
    assert.equal(f.runner.pending().length, 0);
    assert.throws(() => f.runner.resolve(f.id, "success", "different"), /TASK_NOT_AMBIGUOUS/);
  });

for (const kind of ["silent", "tool", "retry"]) {
  test(`slow healthy ${kind} survives the discovery bound without cancellation or duplicate dispatch`,
    { timeout: 3000 }, async (t) => {
      const f = fixture(t, { policy: { ...shortPolicy, progressMs: kind === "silent" ? 1000 : 40, toolMs: 500 } });
      const record = f.runner.load(f.id);
      record.state = "running";
      record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
      f.runner.write(record);
      let cancelled = 0;
      f.runtime.cancelRequest = async () => { cancelled++; };
      f.runtime.observeOwner = connected;
      f.runtime.watchSession = async function* () {
        yield { requestId: record.requestId, type: "message", cursor: "1", message: { params: { update:
          kind === "tool" ? { sessionUpdate: "tool_call", status: "in_progress", toolCallId: "long-tool" }
            : kind === "retry" ? { sessionUpdate: "session_info_update", _meta: { "opencode/retry":
              { nextRetryAt: new Date(Date.now() + 500).toISOString(), attempt: 2 } } }
              : { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" } } } } };
        await delay(180);
        yield { requestId: "someone-else", cursor: "2", type: "turn_result", result: { status: "failed" } };
        yield { requestId: record.requestId, cursor: "3", type: "turn_result", result: { status: "completed" } };
      };
      // Synthetic retry timestamps and the clock must share the same basis.
      f.runner.now = Date.now;
      await f.runner.execute(f.id);
      assert.equal(f.runner.result(f.id).result_status, "success");
      assert.equal(cancelled, 0);
      assert.equal(f.executions(), 0);
    });
}

test("a responsive but unobservable request reports supervision failure, never a guessed business terminal",
  { timeout: 2000 }, async (t) => {
    const f = fixture(t, { policy: { ...shortPolicy, progressMs: 60 } });
    f.runtime.observeOwner = connected;
    f.runtime.startTurn = () => ({ promptStarted: Promise.resolve(), events: (async function* () { await never(); })(), result: never() });
    f.runtime.watchSession = async function* () { await never(); };
    await f.runner.execute(f.id);
    assert.equal(f.runner.load(f.id).state, "ambiguous");
    assert.equal(f.runner.load(f.id).executionError, "PROGRESS_UNCONFIRMED");
    f.runner.fail(f.runner.load(f.id), "PROGRESS_UNCONFIRMED");
    assert.equal(f.runner.result(f.id).result_status, null);
    assert.equal(f.runner.result(f.id).timing.terminal_at, null);
  });

test("a shared healthy owner cannot indefinitely hide an unacknowledged original dispatch",
  { timeout: 2000 }, async (t) => {
    const f = fixture(t, { policy: shortPolicy });
    let dispatches = 0;
    let cancelled = 0;
    f.runtime.observeOwner = connected;
    f.runtime.cancelRequest = async () => { cancelled++; };
    f.runtime.startTurn = () => {
      dispatches++;
      return { promptStarted: never(), events: (async function* () { await never(); })(), result: never() };
    };
    f.runtime.watchSession = async function* ({ signal }) {
      while (!signal.aborted) {
        await delay(10);
        yield { requestId: "another-request", type: "turn_started", cursor: "other" };
      }
    };
    const began = performance.now();
    await f.runner.execute(f.id);
    assert.ok(performance.now() - began < 1000);
    assert.equal(f.runner.load(f.id).state, "ambiguous");
    assert.equal(f.runner.load(f.id).executionError, "REQUEST_UNOBSERVABLE");
    f.runner.fail(f.runner.load(f.id), "REQUEST_UNOBSERVABLE");
    await f.runner.execute(f.id);
    assert.equal(f.runner.result(f.id).result_status, null);
    assert.equal(f.runner.result(f.id).callback_kind, "supervision_failure");
    assert.equal(dispatches, 1);
    assert.equal(cancelled, 0);
  });

for (const progress of ["active", "tool_running"]) {
  test(`recovery retains the persisted quiet interval for ${progress}`,
    { timeout: 2500 }, async (t) => {
      const f = fixture(t, { policy: { ...shortPolicy, progressMs: 500, toolMs: 1200 } });
      const record = f.runner.load(f.id);
      record.state = "running";
      record.originalObserved = true;
      record.cursor = "saved-cursor";
      record.health = { lastEventAt: 1000, progress };
      record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
      f.runner.write(record);
      f.advance(2000);
      f.runtime.observeOwner = connected;
      f.runtime.watchSession = async function* ({ cursor }) {
        assert.equal(cursor, "saved-cursor");
        yield { requestId: "another-request", type: "turn_started", cursor: "other" };
        await never();
      };
      const began = performance.now();
      await f.runner.execute(f.id);
      assert.ok(performance.now() - began < 350);
      assert.equal(f.runner.load(f.id).executionError, "PROGRESS_UNCONFIRMED");
      assert.equal(f.runner.load(f.id).health.lastEventAt, 1000);
      assert.equal(f.runner.result(f.id).result_status, null);
      assert.equal(f.executions(), 0);
    });
}

test("monitor seals a worker spawn error and delivers without needing a working driver", { timeout: 2000 }, async (t) => {
  const f = fixture(t, { policy: shortPolicy, fetcher: async () => ok() });
  let launches = 0;
  await supervise(f.runner, f.id, () => {
    launches++;
    const child = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("synthetic ENOENT")));
    return child;
  });
  assert.equal(launches, 1);
  assert.equal(f.runner.load(f.id).state, "delivered");
  assert.equal(f.runner.load(f.id).executionError, "WORKER_START_FAILED");
  assert.equal(f.executions(), 0);
});

for (const persistent of [false, true]) {
  test(`monitor ${persistent ? "confirms" : "recovers from"} unreadable heartbeat without escaping its timer`,
    { timeout: 2000 }, async (t) => {
      const f = fixture(t, { policy: shortPolicy, fetcher: async () => ok() });
      const heartbeat = f.runner.filename(f.id, "worker.json");
      const open = fs.openSync;
      let reads = 0;
      let stopped = 0;
      let launches = 0;
      let firstErrorAt;
      let stoppedAt;
      if (persistent) {
        const record = f.runner.load(f.id);
        record.state = "running";
        record.originalObserved = true;
        record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
        f.runner.write(record);
      }
      fs.openSync = (...args) => {
        if (args[0] === heartbeat && (persistent || reads++ === 0)) {
          firstErrorAt ??= performance.now();
          throw Object.assign(new Error("synthetic unreadable heartbeat"), { code: "EACCES" });
        }
        return open(...args);
      };
      try {
        await supervise(f.runner, f.id, (_action, _id, token) => {
          launches++;
          const child = new EventEmitter();
          child.exitCode = child.signalCode = null;
          child.kill = (signal) => {
            stopped++; stoppedAt = performance.now(); child.signalCode = signal;
            setImmediate(() => child.emit("exit", null));
          };
          save(heartbeat, { token, sequence: 0 });
          if (!persistent) setTimeout(async () => {
            await f.runner.execute(f.id);
            child.exitCode = 0; child.emit("exit", 0);
          }, 90);
          return child;
        });
      } finally { fs.openSync = open; }
      assert.equal(launches, 1);
      assert.equal(stopped, persistent ? 1 : 0);
      if (persistent) {
        assert.ok(stoppedAt - firstErrorAt >= shortPolicy.confirmMs);
        const record = f.runner.load(f.id);
        assert.equal(record.workerExit.reason, "WORKER_HEARTBEAT_UNREADABLE");
        assert.equal(record.notificationState, "delivered");
        assert.equal(f.runner.result(f.id).result_status, null);
        assert.equal(f.executions(), 0);
      } else {
        assert.equal(f.runner.result(f.id).result_status, "success");
        assert.equal(f.executions(), 1);
      }
    });
}

for (const firstCode of ["ENOENT", "EACCES"]) {
  test(`monitor restarts confirmation when heartbeat reason changes after ${firstCode}`, { timeout: 2000 }, async (t) => {
    const f = fixture(t, { policy: shortPolicy, fetcher: async () => ok() });
    const record = f.runner.load(f.id);
    record.state = "running";
    record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
    f.runner.write(record);
    let tick = 0;
    f.runner.tick = () => tick;
    const open = fs.openSync;
    const heartbeat = f.runner.filename(f.id, "worker.json");
    let reads = 0;
    fs.openSync = (...args) => {
      if (args[0] !== heartbeat) return open(...args);
      const sample = reads++;
      tick = (firstCode === "ENOENT" ? [130, 150, 170, 190, 210] : [80, 100, 130, 150, 170])[sample];
      if (firstCode === "ENOENT" && sample === 1) return open(...args);
      const code = sample < 2 ? firstCode : firstCode === "ENOENT" ? "EACCES" : "ENOENT";
      throw Object.assign(new Error("synthetic observation transition"), { code });
    };
    try {
      await supervise(f.runner, f.id, (_action, _id, token) => {
        save(heartbeat, { token, sequence: 0 });
        const child = new EventEmitter();
        child.exitCode = child.signalCode = null;
        child.kill = (signal) => { child.signalCode = signal; setImmediate(() => child.emit("exit", null)); };
        return child;
      });
    } finally { fs.openSync = open; }
    assert.equal(reads, 5); // 有效进展/原因切换后，新怀疑仍须走完独立确认窗。
    assert.equal(f.runner.load(f.id).workerExit.reason, firstCode === "ENOENT" ? "WORKER_HEARTBEAT_UNREADABLE" : "WORKER_UNRESPONSIVE");
    assert.equal(f.runner.load(f.id).notificationState, "delivered");
    assert.equal(f.executions(), 0);
  });
}

test("alternating read failures cannot renew an expired worker heartbeat budget", { timeout: 2000 }, async (t) => {
  const f = fixture(t, { policy: shortPolicy, fetcher: async () => ok() });
  const record = f.runner.load(f.id);
  record.state = "running";
  record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
  f.runner.write(record);
  let tick = 0;
  let reads = 0;
  f.runner.tick = () => tick;
  const open = fs.openSync;
  const heartbeat = f.runner.filename(f.id, "worker.json");
  fs.openSync = (...args) => {
    if (args[0] !== heartbeat) return open(...args);
    tick = ++reads * 10;
    throw Object.assign(new Error("synthetic alternating read failure"), { code: reads % 2 ? "EACCES" : "ENOENT" });
  };
  try {
    await supervise(f.runner, f.id, () => {
      const child = new EventEmitter();
      child.exitCode = child.signalCode = null;
      child.kill = (signal) => { child.signalCode = signal; setImmediate(() => child.emit("exit", null)); };
      return child;
    });
  } finally { fs.openSync = open; }
  assert.equal(reads, 17);
  assert.equal(f.runner.load(f.id).workerExit.reason, "WORKER_UNRESPONSIVE");
  assert.equal(f.runner.load(f.id).notificationState, "delivered");
  assert.equal(f.executions(), 0);
});

for (const restarted of [false, true]) {
  test(`monitor ${restarted ? "restart" : "worker exit"} observes only the original request`, { timeout: 2000 }, async (t) => {
    const f = fixture(t, { policy: shortPolicy, fetcher: async () => ok() });
    const record = f.runner.load(f.id);
    record.state = restarted ? "dispatching" : "queued";
    record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
    if (restarted) record.workerAttemptedAt = 1;
    f.runner.write(record);
    f.runtime.watchSession = async function* () {
      yield { requestId: record.requestId, type: "turn_result", cursor: "terminal", result: { status: "completed" } };
    };
    const launches = [];
    await supervise(f.runner, f.id, (action) => {
      launches.push(action);
      const child = new EventEmitter();
      setImmediate(async () => {
        if (!restarted && launches.length === 1) {
          record.state = "dispatching"; f.runner.write(record); child.emit("exit", 9); return;
        }
        await f.runner.execute(f.id, { observeOnly: true });
        child.emit("exit", 0);
      });
      return child;
    });
    assert.deepEqual(launches, restarted ? ["_observe"] : ["_worker", "_observe"]);
    assert.equal(launches.length, restarted ? 1 : 2);
    assert.equal(f.executions(), 0);
    assert.equal(f.runner.result(f.id).result_status, "success");
  });
}

test("health configuration rejects invalid bounds and legacy health stays unknown", (t) => {
  assert.deepEqual(healthPolicy(), HEALTH_DEFAULTS);
  assert.throws(() => healthPolicy({ OPENCODE_TASK_WORKER_MS: "100" }), /INVALID_TASK_HEALTH_POLICY/);
  assert.throws(() => healthPolicy({ OPENCODE_TASK_POLL_MS: "NaN" }), /INVALID_TASK_HEALTH_POLICY/);
  const f = fixture(t);
  assert.equal(f.runner.result(f.id).health, null);
  assert.equal(deliveryState(f.runner.load(f.id)), "queued");
});

for (const detailCode of ['QUEUE_DISCONNECTED_BEFORE_COMPLETION', 'WATCH_OUTCOME_UNKNOWN']) {
  test(`failed/${detailCode} is evidence of unknown outcome, never a business failure`, async (t) => {
    const f = fixture(t, { policy: shortPolicy });
    f.runtime.startTurn = () => ({ promptStarted: Promise.resolve(),
      events: (async function* () {})(), result: Promise.resolve({ status: 'failed', error: { code: 'RUNTIME', detailCode } }) });
    f.runtime.watchSession = async function* () {
      if (detailCode === 'WATCH_OUTCOME_UNKNOWN') yield { type: 'turn_result', requestId: f.accepted.request_id,
        cursor: 'unknown', result: { status: 'failed', error: { detailCode } } };
    };
    await f.runner.execute(f.id);
    assert.equal(f.runner.load(f.id).state, 'ambiguous');
    assert.equal(f.runner.load(f.id).body, undefined);
    f.runner.fail(f.runner.load(f.id), 'REQUEST_OUTCOME_UNKNOWN');
    assert.equal(f.runner.result(f.id).result_status, null);
    assert.equal(f.runner.result(f.id).callback_kind, 'supervision_failure');
  });
}

test("supervision notification retries original bytes after restart and never becomes a business result", async (t) => {
  const bodies = [];
  const f = fixture(t, { fetcher: async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) throw new Error("lost receipt");
    return ok();
  } });
  const record = f.runner.load(f.id);
  record.state = "dispatching";
  f.runner.fail(record, "WORKER_EXITED");
  await f.runner.deliver(f.runner.load(f.id));
  f.advance(10000);
  const resumed = new TaskRunner({ root: f.root, now: () => 11000, fetcher: f.runner.fetcher });
  await resumed.execute(f.id);
  await resumed.deliver(resumed.load(f.id));
  assert.deepEqual(bodies, [record.body, record.body]);
  assert.equal(resumed.result(f.id).state, "ambiguous");
  assert.equal(resumed.result(f.id).result_status, null);
  assert.equal(resumed.result(f.id).callback_state, "delivered");
  assert.equal(f.executions(), 0);
});

test("monitor stops only its own unresponsive driver, waits for exit, then watches the original request",
  { timeout: 3000 }, async (t) => {
    const f = fixture(t, { policy: shortPolicy, fetcher: async () => ok() });
    const record = f.runner.load(f.id);
    record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
    const actions = [];
    let stopped = false;
    f.runtime.watchSession = async function* () {
      assert.equal(stopped, true);
      yield { requestId: record.requestId, type: "turn_result", result: { status: "completed" }, cursor: "1" };
    };
    await supervise(f.runner, f.id, (action) => {
      actions.push(action);
      const child = new EventEmitter();
      child.exitCode = null; child.signalCode = null;
      if (actions.length === 1) {
        record.state = "dispatching"; f.runner.write(record);
        child.kill = (signal) => {
          assert.equal(signal, "SIGKILL"); stopped = true;
          setImmediate(() => child.emit("exit", null));
        };
      } else setImmediate(async () => {
        assert.equal(action, "_observe");
        await f.runner.execute(f.id, { observeOnly: true });
        child.emit("exit", 0);
      });
      return child;
    });
    assert.deepEqual(actions, ["_worker", "_observe"]);
    assert.equal(f.runner.result(f.id).result_status, "success");
    assert.equal(f.executions(), 0);
  });

test("progress arriving during an owner probe resets quiet time before evaluation", { timeout: 2000 }, async (t) => {
  const f = fixture(t, { policy: { ...shortPolicy, probeMs: 200, discoveryMs: 500, progressMs: 40 } });
  f.runner.now = Date.now;
  f.runtime.observeOwner = async () => { await delay(90); return connected(); };
  f.runtime.startTurn = () => ({ promptStarted: Promise.resolve(), events: (async function* () {
    await delay(70);
    yield { type: 'text_delta', stream: 'output', text: 'Recent progress' };
  })(), result: delay(110).then(() => ({ status: 'completed' })) });
  await f.runner.execute(f.id);
  assert.equal(f.runner.result(f.id).result_status, 'success');
  assert.equal(f.runner.result(f.id).output, 'Recent progress');
});

test("new original-request progress after an owner change restores observation", { timeout: 2000 }, async (t) => {
  const f = fixture(t, { policy: shortPolicy });
  f.runner.now = Date.now;
  const record = f.runner.load(f.id);
  record.state = "running";
  record.originalObserved = true;
  record.ownerGeneration = 1;
  record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
  f.runner.write(record);
  let generation = 1;
  f.runtime.observeOwner = async () => ({ ...(await connected()), generation });
  f.runtime.watchSession = async function* () {
    yield { type: "turn_started", requestId: record.requestId, cursor: "start" };
    for (let index = 0; index < 8; index++) {
      await delay(30);
      generation = 2;
      yield { type: "message", requestId: record.requestId, cursor: `progress-${index}`,
        message: { params: { update: { sessionUpdate: "agent_thought_chunk" } } } };
    }
    yield { type: "turn_result", requestId: record.requestId, cursor: "done", result: { status: "completed" } };
  };
  await f.runner.execute(f.id);
  assert.equal(f.runner.result(f.id).result_status, "success");
  assert.equal(f.runner.load(f.id).ownerGeneration, 2);
  assert.equal(f.executions(), 0);
});

for (const fault of ["probe", "lease", "journal", "find"]) {
  test(`transient ${fault} interruption reconnects to the original request without consuming its callback`,
    { timeout: 2500 }, async (t) => {
      const f = fixture(t, { policy: shortPolicy });
      const record = f.runner.load(f.id);
      record.state = "running";
      record.originalObserved = true;
      const handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
      if (fault !== "find") record.handle = handle;
      f.runner.write(record);
      let probes = 0;
      f.runtime.observeOwner = async () => {
        if (++probes <= 2 && fault === "probe") return never();
        if (probes <= 3 && fault === "lease") return { owner: "unavailable", process: "alive" };
        return connected();
      };
      let finds = 0;
      f.runtime.findSession = async () => {
        if (++finds === 1) return never();
        return handle;
      };
      let watches = 0;
      f.runtime.watchSession = async function* ({ cursor }) {
        if (fault === "journal" && ++watches === 1) {
          yield { requestId: record.requestId, type: "turn_started", cursor: "saved" };
          throw new Error("synthetic temporary journal read failure");
        }
        if (fault === "journal") assert.equal(cursor, "saved");
        await delay(160);
        yield { requestId: record.requestId, type: "turn_result", cursor: "done", result: { status: "completed" } };
      };
      await f.runner.execute(f.id);
      assert.equal(f.runner.result(f.id).result_status, "success");
      assert.equal(f.runner.result(f.id).callback_kind, "request_result");
      assert.equal(f.runner.load(f.id).notificationKind, undefined);
      assert.equal(f.executions(), 0);
    });
}

test("cold setup finishing in the confirmation grace uses the same pending setup", { timeout: 2000 }, async (t) => {
  const f = fixture(t, { policy: { ...shortPolicy, setupMs: 40, confirmMs: 150 } });
  const ensure = f.runtime.ensureSession;
  let setups = 0;
  f.runtime.ensureSession = async (input) => {
    setups++;
    await delay(85);
    assert.equal(f.runner.status(f.id).health.assessment, "suspected");
    return ensure(input);
  };
  await f.runner.execute(f.id);
  assert.equal(f.runner.result(f.id).result_status, "success");
  assert.equal(f.runner.result(f.id).health.suspected_since, null);
  assert.equal(setups, 1);
  assert.equal(f.executions(), 1);
});

test("unstarted queue wait with a healthy owner can outlast discovery, then start normally", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  f.runtime.observeOwner = connected;
  f.runtime.startTurn = () => ({ promptStarted: delay(220), events: (async function* () { await never(); })(),
    result: delay(270).then(() => ({ status: "completed" })) });
  f.runtime.watchSession = async function* () { await never(); };
  await f.runner.execute(f.id);
  assert.equal(f.runner.result(f.id).result_status, "success");
});

test("new progress retracts suspicion even across a wall-clock jump; terminal beats the next confirmation",
  { timeout: 2500 }, async (t) => {
    const f = fixture(t, { policy: { ...shortPolicy, progressMs: 55, confirmMs: 100 } });
    f.runtime.observeOwner = connected;
    let assessed = false;
    f.runtime.startTurn = () => ({ promptStarted: Promise.resolve(), events: (async function* () {
      await delay(100);
      assert.equal(f.runner.status(f.id).health.assessment, "suspected");
      f.advance(86400000);
      yield { type: "text_delta", stream: "thought", text: "Synthetic progress" };
      await delay(20);
      assert.equal(f.runner.status(f.id).health.assessment, "observing");
      assert.equal(f.runner.status(f.id).health.suspected_since, null);
      assessed = true;
    })(), result: delay(230).then(() => ({ status: "completed" })) });
    f.runtime.watchSession = async function* () { await never(); };
    await f.runner.execute(f.id);
    assert.equal(assessed, true);
    assert.equal(f.runner.result(f.id).result_status, "success");
    assert.equal(f.runner.result(f.id).health.assessment, "settled");
  });

test("another request cannot confirm a replacement owner or hide a persistently missing original request",
  { timeout: 2000 }, async (t) => {
    const f = fixture(t, { fetcher: async () => ok() });
    const record = f.runner.load(f.id);
    record.state = "running";
    record.originalObserved = true;
    record.ownerGeneration = 1;
    record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
    f.runner.write(record);
    f.runtime.observeOwner = async () => ({ ...(await connected()), generation: 2 });
    f.runtime.watchSession = async function* ({ signal }) {
      for (let index = 0; !signal.aborted; index++) {
        await delay(10);
        yield { type: "turn_started", requestId: "other-request", cursor: `other-${index}` };
      }
    };
    const began = performance.now();
    await f.runner.execute(f.id);
    const elapsed = performance.now() - began;
    assert.ok(elapsed >= shortPolicy.discoveryMs + shortPolicy.confirmMs && elapsed < 1000);
    assert.equal(f.runner.load(f.id).executionError, "OWNER_CHANGED");
    assert.equal(f.runner.load(f.id).ownerGeneration, 1);
    f.runner.fail(f.runner.load(f.id), "OWNER_CHANGED");
    await f.runner.deliver(f.runner.load(f.id));
    assert.equal(f.runner.result(f.id).callback_kind, "supervision_failure");
    assert.equal(f.runner.result(f.id).result_status, null);
    assert.equal(f.runner.result(f.id).health.assessment, "unavailable");
    assert.equal(f.executions(), 0);
  });

test("recovery uses the same boot clock for silence despite wall-clock corrections", { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const record = f.runner.load(f.id);
  record.state = "running";
  record.originalObserved = true;
  record.cursor = "saved";
  record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
  f.runner.progress(record, { type: "prompt_started" });
  f.runner.write(record);
  f.advance(86400000);
  const resumed = new TaskRunner({ root: f.root, runtime: f.runtime, now: f.runner.now, policy: shortPolicy });
  f.runtime.observeOwner = connected;
  f.runtime.watchSession = async function* () {
    await delay(150);
    assert.equal(resumed.status(f.id).health.assessment, "observing");
    yield { type: "turn_result", requestId: record.requestId, cursor: "done", result: { status: "completed" } };
  };
  await resumed.execute(f.id);
  assert.equal(resumed.result(f.id).result_status, "success");
  assert.equal(f.executions(), 0);
});

test("confirmation requires fresh repeated observations after a monitor scheduling pause", () => {
  let tick = 0;
  const confirmation = new Confirmation(shortPolicy, () => tick);
  assert.equal(confirmation.update("OWNER_UNAVAILABLE"), false);
  tick = 15;
  assert.equal(confirmation.update("OWNER_UNAVAILABLE"), false);
  tick = 500; // 超过连续观察允许的间隔，即使已过 confirm，也须重新确认。
  assert.equal(confirmation.update("OWNER_UNAVAILABLE"), false);
  tick = 520;
  assert.equal(confirmation.update("OWNER_UNAVAILABLE"), false);
  tick = 545;
  assert.equal(confirmation.update("OWNER_UNAVAILABLE"), true);
  assert.equal(confirmation.update(undefined), false);
});

test("original tool progress during a lease outage still confirms the owner when its lease recovers",
  { timeout: 2000 }, async (t) => {
    const f = fixture(t, { policy: { ...shortPolicy, discoveryMs: 60, toolMs: 700 } });
    const record = f.runner.load(f.id);
    record.state = "running";
    record.originalObserved = true;
    record.ownerGeneration = 1;
    record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
    f.runner.write(record);
    let broken = false;
    let generation = 1;
    f.runtime.observeOwner = async () => broken ? { owner: "unavailable", process: "unknown" }
      : { ...(await connected()), generation };
    f.runtime.watchSession = async function* () {
      yield { type: "turn_started", requestId: record.requestId, cursor: "start" };
      await delay(30);
      broken = true;
      generation = 2;
      yield { type: "message", requestId: record.requestId, cursor: "tool", message: { params: { update:
        { sessionUpdate: "tool_call", status: "in_progress", toolCallId: "continuing-tool" } } } };
      await delay(45);
      broken = false;
      await delay(190);
      yield { type: "turn_result", requestId: record.requestId, cursor: "done", result: { status: "completed" } };
    };
    await f.runner.execute(f.id);
    assert.equal(f.runner.result(f.id).result_status, "success");
    assert.equal(f.runner.load(f.id).ownerGeneration, 2);
    assert.equal(f.executions(), 0);
  });

for (const clock of ["legacy", "unidentified"]) {
  test(`recovery does not renew an expired retry grace with ${clock} clock evidence`, { timeout: 2000 }, async (t) => {
    const f = fixture(t);
    const record = f.runner.load(f.id);
    record.state = "running";
    record.originalObserved = true;
    record.cursor = "saved";
    record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
    record.health = { lastEventAt: 1000, retryUntil: -86400000, progress: "provider_retry",
      ...(clock === "unidentified" ? { retryClock: null, retryTick: f.runner.tick() + 100000 } : {}) };
    f.runner.write(record);
    f.advance(2000);
    if (clock === "unidentified") f.runner.clock = null;
    f.runtime.observeOwner = connected;
    f.runtime.watchSession = async function* () { await never(); };
    const began = performance.now();
    await f.runner.execute(f.id);
    assert.ok(performance.now() - began < 350);
    assert.equal(f.runner.load(f.id).executionError, "PROGRESS_UNCONFIRMED");
    assert.equal(f.runner.result(f.id).result_status, null);
    assert.equal(f.executions(), 0);
  });
}

test("a future retry retains its monotonic deadline through recovery and wall-clock jumps", { timeout: 2000 }, async (t) => {
  const policy = { ...shortPolicy, progressMs: 40 };
  const f = fixture(t, { policy });
  const record = f.runner.load(f.id);
  record.state = "running";
  record.originalObserved = true;
  record.cursor = "retry";
  record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey });
  f.runner.progress(record, { message: { params: { update: { sessionUpdate: "session_info_update",
    _meta: { "opencode/retry": { nextRetryAt: new Date(1300).toISOString() } } } } } });
  f.runner.write(record);
  f.advance(86400000);
  const resumed = new TaskRunner({ root: f.root, runtime: f.runtime, now: f.runner.now, policy });
  f.runtime.observeOwner = connected;
  f.runtime.watchSession = async function* () {
    await delay(180);
    assert.equal(resumed.status(f.id).health.assessment, "observing");
    yield { type: "turn_result", requestId: record.requestId, cursor: "done", result: { status: "completed" } };
  };
  await resumed.execute(f.id);
  assert.equal(resumed.result(f.id).result_status, "success");
});

test("a canonical terminal queued by the confirming probe wins over the supervision notification",
  { timeout: 2000 }, async (t) => {
    const f = fixture(t, { policy: { ...shortPolicy, pollMs: 20, progressMs: 50, confirmMs: 10 } });
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    f.runtime.startTurn = () => ({ promptStarted: Promise.resolve(), events: (async function* () { await never(); })(), result: never() });
    f.runtime.watchSession = async function* () {
      yield { type: "turn_started", requestId: f.accepted.request_id, cursor: "start" };
      await ready;
      yield { type: "turn_result", requestId: f.accepted.request_id, cursor: "done", result: { status: "failed" } };
    };
    let queued = false;
    f.runtime.observeOwner = async () => {
      if (!queued && f.runner.load(f.id).health?.assessment === "suspected") {
        queued = true;
        setTimeout(release, 0); // 与确认同一轮已就绪，不能先封存监督通知。
      }
      return connected();
    };
    await f.runner.execute(f.id);
    assert.equal(queued, true);
    assert.equal(f.runner.result(f.id).result_status, "error");
    assert.equal(f.runner.result(f.id).callback_kind, "request_result");
    assert.equal(f.runner.result(f.id).evidence.terminal_source, "watchSession.turn_result");
  });

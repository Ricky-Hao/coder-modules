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
} from "../scripts/task.mjs";

const callback = {
  callback_id: `tcb_${"x".repeat(43)}`,
  callback_url: "http://127.0.0.1:1/api/agents/task-callbacks",
};
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-task-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true }));
  let executions = 0;
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
    },
    async cancel() {},
  };
  const runner = new TaskRunner({
    root,
    runtime,
    now: () => clock,
    fetcher: options.fetcher,
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
          callbackBody(callback, status, "Done ✓"),
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
  await assert.rejects(f.runner.execute(accepted.task_id), /selection refused/);
  assert.equal(f.executions(), 0);
  assert.equal(f.runner.status(accepted.task_id).execution_error, 'MODEL_OR_SESSION_SETUP_FAILED');
  f.runtime.ensureSession = ensure;
  await f.runner.execute(accepted.task_id);
  assert.equal(f.executions(), 1);
  const completed = f.runner.load(accepted.task_id);
  const recovered = new TaskRunner({ root: f.root, runtime: f.runtime });
  await recovered.execute(accepted.task_id);
  assert.deepEqual(recovered.load(accepted.task_id), completed);
  assert.equal(f.executions(), 1);
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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { TaskRunner, appendOutput, callbackBody, retryDelay, save, validateCallback,
  DEFAULT_NO_PROGRESS_MS, noProgressTimeout, delay } from "../scripts/task.mjs";

const callback = { callback_id: `tcb_${"x".repeat(43)}`, callback_url: "http://127.0.0.1:1/api/agents/task-callbacks" };
const never = () => new Promise(() => {});
const ok = () => new Response(JSON.stringify({ version: 1, receipt_id: "receipt", accepted_at: "2026-10-20T00:00:00Z" }), { status: 202 });
async function until(predicate, ms = 2000) {
  const end = performance.now() + ms;
  while (!predicate()) { if (performance.now() > end) throw new Error("fixture wait expired"); await delay(5); }
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-task-"));
  let executions = 0, requestId;
  const runtime = {
    async ensureSession(input) { return { sessionKey: input.sessionKey, cwd: input.cwd, acpxRecordId: "fixture-record",
      backend: "acpx-shared", backendSessionId: "fixture-session" }; },
    startTurn(input) {
      executions++; requestId = input.requestId;
      assert.equal(input.text.includes(callback.callback_id), false);
      return { promptStarted: Promise.resolve(), events: (async function* () {
        yield { type: "text_delta", stream: "thought", text: "private thought" };
        yield { type: "text_delta", stream: "output", messageId: "intermediate", text: "Working..." };
        yield { type: "text_delta", stream: "output", messageId: "final", text: "Done ✓" };
      })(), result: Promise.resolve({ status: options.result ?? "completed" }) };
    },
    async *watchSession() {
      if (requestId && options.result === "failed") yield { type: "turn_result", requestId, cursor: "failure", result: { status: "failed" } };
    },
    async cancelRequest() {},
  };
  const runner = new TaskRunner({ root, runtime, fetcher: options.fetcher ?? (async () => ok()),
    noProgressMs: 120, pollMs: 5, ioMs: 20, drainMs: 10, ...options });
  const intent = { model: { id: "codex/gpt-6.1-sol", variant: "max" }, modelConfig: path.join(root, "config.json"), modelProfile: "env" };
  const input = { ...intent, key: "local-submit-key", cwd: root, prompt: "Perform the task.", callback: options.callback ?? callback };
  const accepted = runner.submit(input), id = accepted.task_id, stop = new AbortController(), pending = [];
  const run = (extra = {}) => { const promise = runner.control(id, { signal: stop.signal, ...extra }); pending.push(promise); return promise; };
  t.after(async () => { stop.abort(); await Promise.allSettled(pending); fs.rmSync(root, { recursive: true }); });
  return { root, runner, runtime, intent, input, id, accepted, run, stop, executions: () => executions,
    load: () => runner.load(id), result: () => runner.result(id) };
}

for (const [result, status] of [["completed", "success"], ["failed", "error"], ["cancelled", "cancelled"]]) {
  test(`canonical ${status} is durable before exact POST; thought is private`, async (t) => {
    const bodies = [];
    const f = fixture(t, { result, fetcher: async (_url, init) => {
      assert.equal(f.load().body, init.body); assert.equal(f.load().result.status, status);
      assert.equal(init.redirect, "manual"); assert.equal(init.headers.Authorization, undefined);
      bodies.push(init.body); return ok();
    } });
    await f.run();
    assert.equal(f.result().state, "completed"); assert.equal(f.result().result_status, status);
    assert.equal(f.result().callback_state, "delivered");
    assert.equal(f.result().output, status === "error"
      ? "Original request failed (REQUEST_FAILED). Side effects may have occurred; verify before retrying." : "Done ✓");
    assert.equal(bodies.length, 1); assert.equal(f.executions(), 1);
    const before = fs.readFileSync(f.runner.filename(f.id));
    for (const value of [f.result(), f.runner.status(f.id)]) {
      assert.equal(JSON.stringify(value).includes(callback.callback_id), false);
      assert.equal(JSON.stringify(value).includes(callback.callback_url), false);
      assert.equal(JSON.stringify(value).includes("private thought"), false);
    }
    assert.deepEqual(fs.readFileSync(f.runner.filename(f.id)), before);
  });
}

test("default 15 minutes, explicit seconds bound and timeout dedupe identity", (t) => {
  assert.equal(DEFAULT_NO_PROGRESS_MS, 15 * 60 * 1000); assert.equal(noProgressTimeout(), DEFAULT_NO_PROGRESS_MS);
  assert.equal(noProgressTimeout(1), 1000); assert.equal(noProgressTimeout(86400), 86400000);
  for (const value of [0, -1, 1.1, "900", null, 86401, NaN]) assert.throws(() => noProgressTimeout(value), /INVALID_NO_PROGRESS_TIMEOUT/);
  const f = fixture(t);
  assert.deepEqual(f.runner.submit(f.input), f.accepted);
  assert.throws(() => f.runner.submit({ ...f.input, noProgressMs: 200 }), /SUBMIT_CONFLICT/);
});

test("model, policy and cwd/session stay immutable; safe input guards remain", (t) => {
  const f = fixture(t);
  assert.throws(() => f.runner.submit({ ...f.input, prompt: "changed" }), /SUBMIT_CONFLICT/);
  assert.throws(() => f.runner.submit({ ...f.input, prompt: callback.callback_id }), /CALLBACK_IN_PROMPT/);
  assert.throws(() => f.runner.submit({ ...f.input, permissionPolicy: { unknown: [] } }), /INVALID_PERMISSIONS/);
  const input = { ...f.input, key: "named", session: "fixed", permissionMode: "approve-all", permissionPolicy: { autoDeny: ["delete"] } };
  f.runner.submit(input);
  assert.throws(() => f.runner.submit({ ...input, key: "other", model: { id: "copilot/gpt-6-astra", variant: "high" } }), /SESSION_MODEL_CONFLICT/);
  const other = path.join(f.root, "other"); fs.mkdirSync(other, { mode: 0o700 });
  assert.throws(() => f.runner.submit({ ...input, key: "other", cwd: other }), /SESSION_CWD_CONFLICT/);
  for (const url of ["http://example.test/api/agents/task-callbacks", "https://a.test/path?secret=x", "https://u:p@a.test/api/agents/task-callbacks"])
    assert.throws(() => validateCallback({ ...callback, callback_url: url }), /INVALID_CALLBACK/);
});

test("unknown formats are refused without changing bytes or hiding bad records", async (t) => {
  const f = fixture(t); const valid = f.load();
  for (const field of ["version", "model", "modelConfig", "modelProfile", "permissions", "createdAt", "noProgressMs", "progress"]) {
    const old = { ...valid }; delete old[field]; f.runner.write(old);
    const before = fs.readFileSync(f.runner.filename(f.id));
    assert.throws(() => f.result(), /UNSUPPORTED_TASK_RECORD/);
    await assert.rejects(f.runner.execute(f.id), /UNSUPPORTED_TASK_RECORD/);
    await assert.rejects(f.runner.cancel(f.id), /UNSUPPORTED_TASK_RECORD/);
    const unsupported = []; assert.deepEqual(f.runner.pending(unsupported), []);
    assert.deepEqual(unsupported, [{ task_id: f.id, code: "UNSUPPORTED_TASK_RECORD" }]);
    assert.deepEqual(fs.readFileSync(f.runner.filename(f.id)), before);
  }
  f.runner.write(valid); fs.chmodSync(f.runner.filename(f.id), 0o644);
  assert.throws(() => f.runner.pending(), /UNSAFE_TASK_FILE/);
});

test("result returns bounded canonical output and withholds private callback content", (t) => {
  const f = fixture(t, { callback: { ...callback, max_output_bytes: 4 } });
  const record = f.load();
  appendOutput(record, "✓".repeat(20000), "intermediate"); assert.equal(record.outputTruncated, true);
  appendOutput(record, "✓✓", "final"); assert.equal(record.outputTruncated, false);
  f.runner.seal(record, "success", record.output);
  assert.equal(f.result().output, "✓"); assert.equal(f.result().output_truncated, true);
  record.result.output = callback.callback_id;
  f.runner.write(record);
  assert.equal(f.result().output, null); assert.equal(f.result().output_error, "PRIVATE_CALLBACK_CONTENT");
  assert.equal(f.result().output_available, false);
});

test("nonterminal result never exposes prompt or live output", (t) => {
  const f = fixture(t), record = f.load();
  record.output = "Unsealed private output"; f.runner.write(record);
  assert.equal(f.result().output, null); assert.equal(f.result().result_status, null);
  assert.equal(JSON.stringify(f.runner.status(f.id)).includes(record.output), false);
});

test("known setup failure and unified setup timeout cannot dispatch later", async (t) => {
  const f = fixture(t); let complete;
  f.runtime.ensureSession = () => new Promise((resolve) => { complete = resolve; });
  await f.run();
  assert.equal(f.result().result_status, "error"); assert.equal(f.result().evidence.terminal_source, "execution_setup_failure");
  complete({}); await delay(10); assert.equal(f.executions(), 0);
  const g = fixture(t); g.runtime.ensureSession = async () => { throw new Error("private setup detail"); };
  const began = performance.now(); await g.run();
  assert.ok(performance.now() - began < 100); assert.equal(g.executions(), 0);
  assert.equal(g.runner.status(g.id).execution_error, "MODEL_OR_SESSION_SETUP_FAILED");
  assert.equal(g.load().body.includes("private setup detail"), false);
});

test("setup crossing deadline between polls cannot dispatch; terminal receipt stops timeout during drain", async (t) => {
  let tick = 0;
  const f = fixture(t, { tick: () => tick, noProgressMs: 20, pollMs: 50 });
  const ensure = f.runtime.ensureSession;
  f.runtime.ensureSession = async (input) => { tick = 21; return ensure(input); };
  await f.run(); assert.equal(f.executions(), 0); assert.equal(f.result().result_status, "error");
  const g = fixture(t, { noProgressMs: 50, drainMs: 100 });
  g.runtime.startTurn = () => ({ promptStarted: never(), events: (async function* () { await never(); })(),
    result: delay(10).then(() => ({ status: "completed" })) });
  g.runtime.watchSession = async function* () { await never(); };
  await g.run(); assert.equal(g.result().callback_kind, "request_result"); assert.equal(g.result().callback_status, "success");
});

test("terminal journal beats hanging promptStarted and events", async (t) => {
  const f = fixture(t);
  f.runtime.startTurn = () => ({ promptStarted: never(), events: (async function* () { await never(); })(), result: never() });
  f.runtime.watchSession = async function* () { yield { type: "turn_result", requestId: f.accepted.request_id, result: { status: "failed" }, cursor: "1" }; };
  await f.run(); assert.equal(f.result().result_status, "error"); assert.equal(f.result().timing.started_at, null);
});

for (const kind of ["thought", "tool"]) {
  test(`original ${kind} events renew the one timeout, other request events do not`, async (t) => {
    const f = fixture(t, { noProgressMs: 70 });
    f.runtime.startTurn = () => ({ promptStarted: never(), events: (async function* () {})(), result: never() });
    f.runtime.watchSession = async function* () {
      for (let i = 0; i < 5; i++) {
        await delay(25);
        yield { type: "message", requestId: f.accepted.request_id, cursor: String(i), message: { params: { update:
          kind === "thought" ? { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" } }
            : { sessionUpdate: "tool_call_update", toolCallId: "build", status: "in_progress" } } } };
      }
      yield { type: "turn_result", requestId: "other", result: { status: "completed" }, cursor: "other" };
      await delay(110);
      assert.equal(f.result().callback_kind, "no_progress");
      yield { type: "turn_result", requestId: f.accepted.request_id, result: { status: "completed" }, cursor: "done" };
    };
    await f.run(); assert.equal(f.result().result_status, "success"); assert.equal(f.result().callback_kind, "no_progress");
    assert.equal(f.load().attempts, 0);
  });
}

for (const update of [{ sessionUpdate: "tool_call", toolCallId: "build", status: "in_progress" },
  { sessionUpdate: "session_info_update", _meta: { "opencode/retry": { nextRetryAt: "2099-01-01T00:00:00Z" } } }]) {
  test(`tool/retry metadata grants no extra silence allowance: ${update.sessionUpdate}`, async (t) => {
    const f = fixture(t, { noProgressMs: 55 });
    f.runtime.startTurn = () => ({ promptStarted: never(), events: (async function* () {})(), result: never() });
    f.runtime.watchSession = async function* () {
      yield { type: "message", requestId: f.accepted.request_id, cursor: "1", message: { params: { update } } };
      await never();
    };
    const began = performance.now(), running = f.run();
    await until(() => f.result().callback_state === "delivered");
    assert.ok(performance.now() - began < 180); assert.equal(f.result().result_status, null);
    f.stop.abort(); await running;
  });
}

for (const status of ["completed", "failed", "cancelled"]) {
  test(`one timeout notification then late canonical ${status}; body and POST count unchanged`, async (t) => {
    const bodies = [], f = fixture(t, { noProgressMs: 45, fetcher: async (_url, init) => { bodies.push(init.body); return ok(); } });
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    f.runtime.startTurn = () => ({ promptStarted: Promise.resolve(), events: (async function* () {})(), result: never() });
    f.runtime.watchSession = async function* () {
      await done;
      yield { type: "message", requestId: f.accepted.request_id, cursor: "text", message: { params: { update:
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Late result" }, messageId: "final" } } } };
      yield { type: "turn_result", requestId: f.accepted.request_id, cursor: "done", result: { status } };
    };
    const running = f.run(); await until(() => f.result().callback_state === "delivered");
    const body = f.load().body;
    assert.match(JSON.parse(body).output, /outcome and side effects are unknown/);
    assert.equal(f.result().result_status, null); assert.equal(f.result().timing.terminal_at, null);
    finish(); await running;
    assert.equal(f.result().result_status, status === "completed" ? "success" : status === "failed" ? "error" : "cancelled");
    assert.equal(f.result().callback_status, "error"); assert.equal(f.result().callback_kind, "no_progress");
    assert.equal(f.load().body, body); assert.equal(bodies.length, 1);
    if (status !== "failed") assert.equal(f.result().output, "Late result");
    assert.equal(f.runner.pending().length, 0);
  });
}

test("blocked outbox retry does not block late canonical save; restart retries original bytes", async (t) => {
  const bodies = []; let respond;
  const f = fixture(t, { noProgressMs: 35, fetcher: async (_url, init) => { bodies.push(init.body); return new Promise((resolve) => { respond = resolve; }); } });
  let finish; const done = new Promise((resolve) => { finish = resolve; });
  f.runtime.startTurn = () => ({ promptStarted: Promise.resolve(), events: (async function* () {})(), result: never() });
  f.runtime.watchSession = async function* () { await done; yield { type: "turn_result", requestId: f.accepted.request_id, cursor: "done", result: { status: "completed" } }; };
  const running = f.run(); await until(() => bodies.length === 1);
  finish(); await until(() => f.result().result_status === "success");
  assert.equal(f.result().callback_state, "outbox");
  respond(new Response("bad receipt", { status: 202 })); await until(() => f.load().attempts === 1);
  f.stop.abort(); await running;
  const record = f.load(), body = record.body; record.nextAttemptAt = 0; f.runner.write(record);
  const restarted = new TaskRunner({ root: f.root, runtime: { startTurn() { assert.fail("replay"); } }, pollMs: 5,
    fetcher: async (_url, init) => { bodies.push(init.body); return ok(); } });
  await restarted.control(f.id, { observeOnly: true });
  assert.deepEqual(bodies, [body, body]); assert.equal(restarted.result(f.id).result_status, "success");
});

test("disconnect/reconnect and explicit recover preserve remaining silence and cursor", async (t) => {
  const f = fixture(t, { noProgressMs: 130 }); let watches = 0;
  f.runtime.startTurn = () => { throw new Error("response lost"); };
  f.runtime.watchSession = async function* ({ cursor }) {
    watches++;
    if (watches === 1) { yield { type: "turn_started", requestId: f.accepted.request_id, cursor: "saved" }; throw new Error("disconnected"); }
    assert.equal(cursor, "saved"); await never();
  };
  const running = f.run(); await until(() => watches >= 2); await delay(70); f.stop.abort(); await running;
  const before = f.load().progress;
  const stopped = new AbortController();
  const restarted = new TaskRunner({ root: f.root, runtime: f.runtime, pollMs: 5, fetcher: async () => ok() });
  const began = performance.now(), recovered = restarted.control(f.id, { observeOnly: true, signal: stopped.signal });
  await until(() => restarted.result(f.id).callback_state === "delivered");
  assert.ok(performance.now() - began < 100);
  assert.deepEqual(restarted.load(f.id).progress, before);
  assert.equal(restarted.result(f.id).result_status, null); stopped.abort(); await recovered;
});

test("continuous other-request traffic and read queries cannot renew original deadline", async (t) => {
  const f = fixture(t, { noProgressMs: 45 });
  f.runtime.startTurn = () => ({ promptStarted: never(), events: (async function* () {})(), result: never() });
  f.runtime.watchSession = async function* () {
    for (let i = 0; i < 12; i++) {
      await delay(10); f.runner.status(f.id);
      yield { type: "message", requestId: "other", cursor: String(i), message: { params: { update: { sessionUpdate: "agent_thought_chunk" } } } };
    }
    assert.equal(f.result().callback_kind, "no_progress");
    yield { type: "turn_result", requestId: f.accepted.request_id, cursor: "done", result: { status: "completed" } };
  };
  await f.run(); assert.equal(f.result().result_status, "success"); assert.equal(f.result().callback_kind, "no_progress");
});

test("cross-boot recover uses original wall interval and never gives a fresh timeout", async (t) => {
  const f = fixture(t, { noProgressMs: 100 }), record = f.load();
  record.state = "dispatching"; record.progress = { at: 1000, tick: 0, clock: "previous-boot" };
  record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey }); f.runner.write(record);
  f.runner.clock = "current-boot"; f.runner.now = () => 5000;
  f.runtime.watchSession = async function* () { await never(); };
  const running = f.run({ observeOnly: true });
  await until(() => f.result().callback_state === "delivered");
  assert.equal(f.result().timing.notification_at, 5000); assert.deepEqual(f.load().progress, record.progress);
  assert.equal(f.executions(), 0); f.stop.abort(); await running;
});

test("uncertain transport failed is never canonical failure or replay authorization", async (t) => {
  const f = fixture(t, { noProgressMs: 35 }); let starts = 0;
  f.runtime.startTurn = () => { starts++; return { promptStarted: never(), events: (async function* () {})(),
    result: Promise.resolve({ status: "failed", error: { detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION" } }) }; };
  f.runtime.watchSession = async function* () { yield { type: "turn_result", requestId: f.accepted.request_id, cursor: "unknown",
    result: { status: "failed", error: { detailCode: "WATCH_OUTCOME_UNKNOWN" } } }; await never(); };
  const running = f.run(); await until(() => f.result().callback_state === "delivered");
  assert.equal(f.result().result_status, null); assert.equal(starts, 1); f.stop.abort(); await running;
});

test("recover never dispatches queued/preparing; known non-dispatch failure stays truthful", async (t) => {
  for (const state of ["queued", "preparing"]) {
    const f = fixture(t), record = f.load(); record.state = state; f.runner.write(record);
    await f.run({ observeOnly: true });
    assert.equal(f.executions(), 0); assert.equal(f.result().result_status, "error");
    assert.equal(f.result().evidence.terminal_source, "execution_setup_failure");
  }
});

test("cancel only targets original request; RPC acknowledgement does not settle business", async (t) => {
  const f = fixture(t), record = f.load();
  record.state = "running"; record.dispatchedAt = Date.now();
  record.handle = await f.runtime.ensureSession({ cwd: f.root, sessionKey: record.sessionKey }); f.runner.write(record);
  const calls = []; f.runtime.cancelRequest = async (input) => { calls.push(input); return true; };
  f.runtime.cancel = () => assert.fail("session-wide cancel");
  await f.runner.cancel(f.id);
  assert.equal(calls[0].requestId, record.requestId); assert.equal(f.result().result_status, null);
  assert.equal(f.runner.status(f.id).cancel_requested, true);
  record.handle.cwd = "/other"; f.runner.write(record);
  await assert.rejects(f.runner.cancel(f.id), /SESSION_IDENTITY_CONFLICT/);
  const queued = fixture(t); await queued.runner.cancel(queued.id); await queued.run();
  assert.equal(queued.result().result_status, "cancelled"); assert.equal(queued.executions(), 0);
});

test("retry classification preserves Retry-After, invalid receipt and explicit rejection", async (t) => {
  const bodies = [], responses = [new Response("", { status: 429, headers: { "Retry-After": "60" } }),
    new Response("{}", { status: 202 }), new Response("", { status: 403 })];
  const f = fixture(t, { fetcher: async (_url, init) => { bodies.push(init.body); return responses.shift(); } });
  await f.runner.execute(f.id);
  let record = f.load(); record.body = JSON.stringify(JSON.parse(record.body), null, 2) + "\n"; f.runner.write(record);
  const began = Date.now(); await f.runner.deliver(record);
  assert.ok(record.nextAttemptAt >= began + 60000);
  for (let i = 0; i < 2; i++) { record.nextAttemptAt = 0; await f.runner.deliver(record); }
  assert.equal(record.callbackState, "rejected"); assert.equal(f.runner.status(f.id).delivery_error, "CALLBACK_REJECTED");
  assert.equal(new Set(bodies).size, 1); assert.equal(retryDelay(99, "1", 0), 300000);
  assert.equal(retryDelay(0, "999999999", 0), 86400000);
});

test("HTTP redirect cannot leak bearer to another endpoint", async (t) => {
  let received = 0;
  const target = http.createServer((_req, res) => { received++; res.end(); });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const source = http.createServer((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}` }); res.end(); });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  t.after(() => { source.close(); target.close(); });
  const f = fixture(t, { fetcher: fetch, callback: { ...callback, callback_url: `http://127.0.0.1:${source.address().port}/api/agents/task-callbacks` } });
  await f.run(); assert.equal(received, 0); assert.equal(f.runner.status(f.id).delivery_error, "REDIRECT_REFUSED");
});

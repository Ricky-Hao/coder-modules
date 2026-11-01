import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaskStore, TaskError, delay, save, callback, permissions, noProgressTimeout, runtimeError } from "../scripts/task.mjs";
import { TaskWorker, retryDelay } from "../scripts/task-worker.mjs";
import { readyTask, accepted, mockRuntime, deferred } from "./task-fixture.mjs";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "thin-task-")); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = 10000;
  const store = new TaskStore(root, { now: () => time, tick: () => time, boot: "fixture", ...options.clock });
  const task = readyTask(store, {}, options.task), runtime = mockRuntime(task), stop = new AbortController();
  const worker = new TaskWorker(store, { runtime, pollMs: 5, ioMs: 30, fetcher: accepted, ...options });
  const run = (extra = {}) => worker.run(task, { signal: stop.signal, ...extra });
  return { root, store, task, runtime, worker, stop, run, advance: (ms) => { time += ms; },
    result: () => store.summary(store.load(task.id), { output: true }) };
}
async function until(predicate) {
  const end = performance.now() + 1500;
  while (!predicate()) { if (performance.now() > end) assert.fail("fixture condition did not arrive"); await delay(5); }
}
const text = (value, messageId = "answer") => ({ type: "message", message: { params: { update: {
  sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: value } } } } });
test("single dispatch, closed side stream, one journal output, cursor coalesced and canonical result", async (t) => {
  const f = fixture(t), running = f.run(); await until(() => f.runtime.starts);
  assert.equal(f.store.load(f.task.id).phase, "dispatched");
  f.runtime.started.resolve(); f.runtime.push(text("draft", "draft"));
  f.runtime.push(text("final ")); f.runtime.push(text("answer"));
  f.runtime.push({ type: "turn_result", result: { status: "completed" } }); await running;
  assert.equal(f.runtime.closes, 1); assert.equal(f.runtime.starts, 1);
  assert.equal(f.result().output, "final answer"); assert.equal(f.result().output_incomplete, false);
  assert.equal(f.result().callback_state, "delivered");
  assert.equal(f.store.load(f.task.id).output.text, "final answer");
  for (const key of ["prompt", "callback", "body", "origin", "tail", "launch"]) assert.equal(Object.hasOwn(f.task, key), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.store.filename(f.task.id))).sort(), ["outbox.json", "task.json"]);
});
test("terminal Promise survives journal failure and reports incomplete output", async (t) => {
  const f = fixture(t); f.runtime.watchSession = async function* () { throw Object.assign(new Error("PRIVATE"), { code: "WATCH_CURSOR_EXPIRED" }); };
  const running = f.run(); await until(() => f.runtime.starts);
  f.runtime.result.resolve({ status: "completed" });
  await until(() => f.store.load(f.task.id).result); assert.equal(f.store.load(f.task.id).result.status, "success");
  f.task.output = { text: "x".repeat(32768), truncated: false };
  f.advance(31); await running;
  assert.equal(f.result().result_status, "success"); assert.equal(f.result().output_incomplete, true);
  assert.match(f.result().callback_output, /^Output incomplete/); assert.equal(JSON.stringify(f.task).includes("PRIVATE"), false);
});
test("Promise failed is communication uncertainty; journal failed is canonical", async (t) => {
  const f = fixture(t), running = f.run(); await until(() => f.runtime.starts);
  f.runtime.result.resolve({ status: "failed", error: { detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION", message: "PRIVATE" } });
  await delay(15); assert.equal(f.result().result_status, null);
  f.runtime.push({ type: "turn_result", result: { status: "failed", error: { detailCode: "QUEUE_RUNTIME_PROMPT_FAILED", message: "PRIVATE" } } });
  await running; assert.equal(f.result().result_status, "error");
  assert.equal(f.result().execution_error.reason, "QUEUE_RUNTIME_PROMPT_FAILED"); assert.equal(f.runtime.starts, 1);
  assert.equal(JSON.stringify(f.task).includes("PRIVATE"), false);
});
test("default/explicit deadline, unrelated requests, empty watches and queries never renew", async (t) => {
  assert.equal(noProgressTimeout(), 900000); assert.equal(noProgressTimeout(2), 2000);
  for (const value of [0, 1.5, 86401, "2"]) assert.throws(() => noProgressTimeout(value), /INVALID_TIMEOUT/);
  const f = fixture(t, { task: { noProgressMs: 1000 } }), running = f.run(); await until(() => f.runtime.starts);
  f.runtime.push({ ...text("unrelated"), requestId: "other" }); f.advance(900); await delay(15);
  f.result(); assert.equal(f.task.progress.at, 10000);
  f.runtime.push(text("original")); await until(() => f.task.progress.at === 10900);
  f.advance(999); await delay(10); assert.equal(f.store.outbox(f.task), undefined);
  f.advance(1); await until(() => f.store.outbox(f.task));
  const body = f.store.outbox(f.task).body;
  assert.equal(JSON.parse(body).status, "error"); assert.equal(f.result().result_status, null);
  f.runtime.push(text(" late")); f.runtime.push({ type: "turn_result", result: { status: "completed" } });
  await running; assert.equal(f.result().output, "original late"); assert.equal(f.store.outbox(f.task).body, body);
});
test("same boot and cross boot retain remaining deadline", (t) => {
  const f = fixture(t); f.advance(1234);
  assert.equal(f.store.remaining(f.task), 898766);
  const other = new TaskStore(f.root, { now: () => 12000, tick: () => 1, boot: "new" });
  assert.equal(other.remaining(f.task), 898000);
});
test("terminal between polls respects the elapsed deadline; notification failure preserves canonical", async (t) => {
  for (const failNotification of [false, true]) {
    const f = fixture(t, { task: { noProgressMs: 1000 } }), running = f.run();
    const failure = failNotification ? assert.rejects(running, /TASK_WRITE_FAILED/) : undefined;
    await until(() => f.runtime.starts);
    if (failNotification) f.worker.seal = () => { throw new TaskError("TASK_WRITE_FAILED", { stage: "storage" }); };
    f.advance(1000);
    f.runtime.result.resolve({ status: "completed" });
    await until(() => f.store.load(f.task.id).result);
    assert.equal(f.result().result_status, "success");
    if (failNotification) await failure;
    else {
      assert.equal(f.store.outbox(f.task).kind, "no_progress");
      f.stop.abort(); await running;
    }
  }
});
test("many journal deltas share loop writes; WATCH_OUTCOME_UNKNOWN never becomes canonical", async (t) => {
  const f = fixture(t); let writes = 0; const write = f.store.write.bind(f.store);
  f.store.write = (task) => { writes++; write(task); };
  const running = f.run(); await until(() => f.runtime.starts);
  for (let index = 0; index < 100; index++) f.runtime.push(text("x"));
  f.runtime.push({ type: "turn_result", result: { status: "failed", error: { detailCode: "WATCH_OUTCOME_UNKNOWN" } } });
  await until(() => f.task.output?.text.length === 100);
  assert.equal(f.task.result, undefined); assert.ok(writes < 10);
  f.runtime.push({ type: "turn_result", result: { status: "completed" } }); await running;
  assert.equal(f.result().output, "x".repeat(100)); assert.equal(f.runtime.starts, 1);
});
for (const cancelled of [false, true]) test(`late initialization cannot dispatch after ${cancelled ? "cancel" : "timeout"}`, async (t) => {
  const f = fixture(t, { task: { noProgressMs: 1000 } }), initialized = deferred();
  f.runtime.ensureSession = () => initialized.promise;
  const running = f.run(); await delay(5);
  if (cancelled) save(f.store.filename(f.task.id, "cancel.request"), { requested: true });
  else f.advance(1000);
  if (!cancelled) await until(() => f.task.result);
  initialized.resolve(f.runtime.handle); await running;
  assert.equal(f.runtime.starts, 0); assert.equal(f.result().result_status, cancelled ? "cancelled" : "error");
});
test("ready recover never dispatches; dispatched recover only watches; terminal recover only delivers", async (t) => {
  const ready = fixture(t); await ready.run({ recover: true }); assert.equal(ready.runtime.starts, 0);
  assert.equal(ready.result().execution_error.code, "RECOVERED_BEFORE_DISPATCH");
  const f = fixture(t); f.task.phase = "dispatched"; f.task.dispatchedAt = 10000; f.task.handle = f.runtime.handle; f.store.write(f.task);
  const running = f.run({ recover: true }); await delay(10);
  f.runtime.push({ type: "turn_result", result: { status: "cancelled" } }); await running;
  assert.equal(f.runtime.starts, 0); assert.equal(f.result().result_status, "cancelled");
  const box = f.store.outbox(f.task); box.state = "pending"; save(f.store.filename(f.task.id, "outbox.json"), box);
  const recovered = new TaskWorker(f.store, { connect: () => assert.fail("finished must not initialize adapter"), fetcher: accepted, pollMs: 5 });
  fs.unlinkSync(f.task.inputFile); await recovered.run(f.store.load(f.task.id), { recover: true });
  assert.equal(f.store.outbox(f.task).state, "delivered");
});
test("worker interruption requires explicit recovery and does not replay", async (t) => {
  const f = fixture(t), running = f.run(); await until(() => f.runtime.starts);
  f.stop.abort(); await running; assert.equal(f.store.load(f.task.id).result, undefined);
  const record = f.store.load(f.task.id), runtime = mockRuntime(record), stop = new AbortController();
  const worker = new TaskWorker(f.store, { runtime, fetcher: accepted, pollMs: 5 });
  const resumed = worker.run(record, { recover: true, signal: stop.signal });
  runtime.push(text("recovered")); runtime.push({ type: "turn_result", result: { status: "completed" } });
  await resumed; assert.equal(runtime.starts, 0); assert.equal(f.result().output, "recovered");
});
test("held HTTP delivery does not block late terminal or journal output", async (t) => {
  const post = deferred(), f = fixture(t, { task: { noProgressMs: 1000 }, fetcher: () => post.promise });
  const running = f.run(); await until(() => f.runtime.starts); f.advance(1000);
  await until(() => f.worker.box?.attemptedAt);
  f.runtime.push(text("late")); f.runtime.push({ type: "turn_result", result: { status: "completed" } });
  await until(() => f.store.load(f.task.id).result); assert.equal(f.result().output, "late");
  post.resolve(accepted()); await running; assert.equal(f.result().callback_kind, "no_progress");
});
for (const response of ["network", "bad-receipt", 408, 425, 429, 503, 302, 403]) test(`durable exact outbox handles ${response}`, async (t) => {
  const seen = [], f = fixture(t, { fetcher: async (_, options) => {
    seen.push(options.body); assert.equal(options.redirect, "manual");
    if (response === "network") throw new Error("PRIVATE");
    if (response === "bad-receipt") return new Response('{"PRIVATE":', { status: 202 });
    return new Response("", { status: response, headers: { "retry-after": "600" } });
  } });
  const running = f.run(); await until(() => f.runtime.starts);
  f.runtime.push({ type: "turn_result", result: { status: "completed" } });
  await until(() => f.store.outbox(f.task)?.attemptedAt);
  if ([302, 403].includes(response)) await running;
  else { await until(() => f.store.outbox(f.task)?.attempts === 1); f.stop.abort(); await running; }
  const box = f.store.outbox(f.task), original = box.body;
  assert.equal(box.state, [302, 403].includes(response) ? "rejected" : "pending");
  assert.equal(JSON.stringify(box).includes("PRIVATE"), false);
  if (Number.isInteger(response) && ![302, 403].includes(response)) assert.equal(box.nextAttemptAt - f.store.now(), 600000);
  const worker = new TaskWorker(f.store, { fetcher: async (_, options) => { seen.push(options.body); return accepted(); }, pollMs: 5 });
  if (box.state === "pending") { box.nextAttemptAt = 0; save(f.store.filename(f.task.id, "outbox.json"), box); await worker.run(f.task, { recover: true }); }
  assert.ok(seen.every((body) => body === original));
});
test("retry delay caps, immutable receipt and structured denials", () => {
  assert.equal(retryDelay(0, null, 0), 5000); assert.equal(retryDelay(99, null, 0), 300000);
  assert.equal(retryDelay(0, "99999999999", 0), 86400000);
  assert.equal(retryDelay(0, new Date(20000).toUTCString(), 0), 20000);
  assert.equal(runtimeError(new Error("auth permission denied"), "setup", "session", "SETUP_FAILED").code, "SETUP_FAILED");
  assert.equal(runtimeError({ code: -32000, data: { authRequired: true } }, "setup", "session", "SETUP_FAILED").code, "AUTH_REQUIRED");
  assert.equal(runtimeError({ detailCode: "PERMISSION_DENIED" }, "result", "request", "REQUEST_FAILED").action, "respect_denial");
  assert.throws(() => permissions("approve-all", { hidden: [] }), /INVALID_PERMISSIONS/);
  assert.throws(() => callback({ callback_id: "bad" }), /INVALID_CALLBACK/);
});
test("escaped maximum output remains readable from task and durable outbox", async (t) => {
  const f = fixture(t), running = f.run(); await until(() => f.runtime.starts);
  const output = '\u0000"\\'.repeat(10922);
  f.runtime.push(text(output)); f.runtime.push({ type: "turn_result", result: { status: "completed" } }); await running;
  assert.ok(fs.statSync(f.store.filename(f.task.id, "outbox.json")).size > 65536);
  assert.equal(f.result().output, output); assert.equal(f.result().callback_output, output);
});
test("dispatch fsync failure prevents startTurn; bad original input stays fail closed", async (t) => {
  const f = fixture(t), write = f.store.write.bind(f.store);
  f.store.write = (task) => { if (task.dispatchedAt) throw new TaskError("TASK_WRITE_FAILED", { stage: "storage" }); return write(task); };
  const running = f.run(); await assert.rejects(running, /TASK_WRITE_FAILED/); assert.equal(f.runtime.starts, 0);
  const other = fixture(t); fs.writeFileSync(other.task.inputFile, '{}');
  await assert.rejects(other.run(), /INPUT_CHANGED/); assert.equal(other.runtime.starts, 0);
  assert.equal(other.store.load(other.task.id).result.status, "error");
});

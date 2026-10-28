import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import {
  TaskRunner,
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
    callback,
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
  await f.runner.deliver(f.runner.load(f.id));
  assert.equal(f.runner.load(f.id).state, "outbox");
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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TaskRunner, HEALTH_DEFAULTS, save } from "../scripts/task.mjs";
import { inspectTask, listTasks, readJson, RECORD_BYTES, PAGE_BYTES } from "../scripts/task-read.mjs";

const callback = { callback_id: `tcb_${"q".repeat(43)}`, callback_url: "http://localhost:1/api/agents/task-callbacks" };
const intent = { model: { id: 'codex/gpt-6.1-sol', variant: 'max' }, modelConfig: '/fixture/config.json', modelProfile: 'env' };
function fixture(t, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-read-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = new TaskRunner({ root, now: () => 100000 });
  const ids = Array.from({ length: count }, (_, index) => runner.submit({ ...intent, key: `key-${index}`, cwd: root,
    prompt: "PRIVATE-PROMPT", callback, ...(index % 2 ? { session: "shared" } : {}) }).task_id);
  for (const method of ["execute", "cancel", "deliver", "write", "observe"])
    runner[method] = () => { throw new Error(`unexpected mutation: ${method}`); };
  return { root, runner, ids, id: ids[0] };
}
function snapshot(root) {
  const values = {};
  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name);
    const info = fs.lstatSync(file);
    values[name] = info.isDirectory() ? snapshot(file) : { mode: info.mode, mtime: info.mtimeMs,
      ctime: info.ctimeMs, bytes: info.isFile() ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "link" };
  }
  return values;
}

test("directory-cookie pagination bounds scan/response, filters, and samples changing states without writes", (t) => {
  const { root, runner, ids } = fixture(t, 24);
  const before = snapshot(root);
  let cursor, pages = 0;
  const seen = [];
  do {
    const page = listTasks(runner, { "--limit": "2", "--scan-limit": "5", ...(cursor ? { "--cursor": cursor } : {}) });
    assert.ok(page.items.length <= 2);
    assert.ok(page.coverage.entries_scanned <= 5);
    assert.ok(page.coverage.directory_entries_read <= 5);
    assert.ok(page.coverage.record_bytes_read <= PAGE_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 20000);
    seen.push(...page.items.map((item) => item.task_id));
    cursor = page.next_cursor;
    assert.ok(++pages < 30);
  } while (cursor);
  assert.equal(new Set(seen).size, ids.length);
  assert.equal(seen.length, ids.length);
  const changed = runner.load(ids[1]);
  changed.state = "running";
  save(runner.filename(ids[1]), changed);
  const selected = listTasks(runner, { "--state": "running", "--session": "shared", "--scan-limit": "100" });
  assert.deepEqual(selected.items.map((item) => item.task_id), [ids[1]]);
  const afterChange = snapshot(root);
  listTasks(runner);
  inspectTask(runner, ids[0]);
  runner.status(ids[0]);
  runner.result(ids[0]);
  assert.deepEqual(snapshot(root), afterChange);
  assert.notDeepEqual(afterChange, before);
  const text = JSON.stringify(selected);
  for (const secret of [root, "PRIVATE-PROMPT", callback.callback_id, callback.callback_url, '"output"', '"cwd"'])
    assert.equal(text.includes(secret), false, secret);
});

test("small limits never parse all historical records; cursors bind filters and directory membership", (t) => {
  const { root, runner } = fixture(t, 80);
  const page = listTasks(runner, { "--limit": "1", "--scan-limit": "3", "--state": "ambiguous" });
  assert.ok(page.coverage.records_checked <= 3);
  assert.equal(page.coverage.complete, false);
  assert.equal(page.coverage.stop_reason, "scan_limit");
  assert.equal(page.coverage.remaining_records, null);
  assert.ok(page.next_cursor);
  assert.throws(() => listTasks(runner, { "--cursor": page.next_cursor }), /INVALID_CURSOR/);
  fs.mkdirSync(path.join(root, `task_${"f".repeat(64)}`), { mode: 0o700 });
  assert.throws(() => listTasks(runner, { "--cursor": page.next_cursor, "--state": "ambiguous" }), /CURSOR_STALE/);
  for (const flags of [{ "--limit": "51" }, { "--scan-limit": "201" }, { "--state": "private-error" },
    { "--cursor": "x".repeat(1025) }, { "--session": callback.callback_id }])
    assert.throws(() => listTasks(runner, flags));
});

test("empty, missing, unsupported, malformed and unsafe records have explicit bounded coverage", (t) => {
  const { root, runner, id } = fixture(t, 0);
  assert.deepEqual(listTasks(runner).items, []);
  assert.equal(listTasks(runner).coverage.complete, true);
  assert.throws(() => inspectTask(runner, `task_${"0".repeat(64)}`), { code: "ENOENT" });
  const ids = [];
  for (let index = 0; index < 8; index++) {
    const key = `task_${String(index).repeat(64)}`;
    ids.push(key);
    fs.mkdirSync(path.join(root, key), { mode: 0o700 });
    save(path.join(root, key, "task.json"), { ...intent, version: 1, id: key, requestId: "request", state: "queued", callback,
      createdAt: 10000, permissions: { mode: 'deny-all', policy: {} } });
  }
  const pending = inspectTask(runner, ids[0]);
  assert.equal(pending.health, null);
  assert.equal(pending.timing.started_at, null);
  assert.equal(pending.durations.accepted_to_started.ms, null);
  assert.equal(pending.callback.retry_count, null);
  for (const bad of [[], null, "PRIVATE-RAW-ERROR"]) {
    save(runner.filename(ids[0], "worker.json"), bad);
    assert.throws(() => inspectTask(runner, ids[0]), /INVALID_TASK_RESULT/);
  }
  fs.unlinkSync(runner.filename(ids[0], "worker.json"));
  fs.writeFileSync(runner.filename(ids[1]), '{"PRIVATE-RAW-ERROR":');
  fs.chmodSync(runner.filename(ids[2]), 0o644);
  fs.linkSync(runner.filename(ids[3]), path.join(root, "hardlink"));
  fs.unlinkSync(runner.filename(ids[4]));
  fs.symlinkSync(runner.filename(ids[0]), runner.filename(ids[4]));
  fs.unlinkSync(runner.filename(ids[5]));
  spawnSync("mkfifo", ["-m", "600", runner.filename(ids[5])]);
  fs.unlinkSync(runner.filename(ids[6]));
  save(runner.filename(ids[7]), { version: 1, id: ids[7], state: 'ambiguous', callback });
  const page = listTasks(runner);
  assert.equal(page.items.length, 1);
  assert.equal(page.errors.length, 7);
  assert.ok(page.errors.some((entry) => entry.code === 'UNSUPPORTED_TASK_RECORD'));
  assert.equal(page.coverage.exhausted, true);
  assert.equal(page.coverage.complete, false);
  assert.equal(page.coverage.records_checked, 1);
  assert.ok(page.errors.some((entry) => entry.code === "TASK_NOT_FOUND"));
  assert.equal(JSON.stringify(page).includes("PRIVATE-RAW-ERROR"), false);
  fs.chmodSync(path.join(root, ids[0]), 0o755);
  assert.throws(() => inspectTask(runner, ids[0]), /UNSAFE_TASK_DIRECTORY/);
  assert.equal(id, undefined);
});

test("single-fd reads accept real atomic replacements and bound retry; genuine unsafe files still fail closed", (t) => {
  const { runner, id } = fixture(t);
  const file = runner.filename(id);
  const originalStat = fs.fstatSync;
  let replacements = 1, unlinked = 0;
  const current = JSON.parse(fs.readFileSync(file));
  t.mock.method(fs, "fstatSync", (fd) => {
    if (replacements++ === 1) save(file, { ...current, requestId: "updated-request" });
    const info = originalStat(fd);
    if (info.nlink === 0) unlinked++;
    return info;
  });
  assert.equal(readJson(file).requestId, "updated-request");
  assert.equal(unlinked, 1);
  t.mock.restoreAll();
  const originalRead = fs.readSync;
  const requests = [];
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
    requests.push(length);
    return originalRead(fd, buffer, offset, length, position);
  });
  assert.equal(readJson(file).requestId, "updated-request");
  assert.ok(Math.max(...requests) < 16384, "小记录不应分配/请求整个 8 MiB 限额");
  t.mock.restoreAll();
  t.mock.method(fs, "fstatSync", (fd) => {
    const info = originalStat(fd);
    fs.appendFileSync(file, "  ");
    return info;
  });
  assert.throws(() => readJson(file), /TASK_RECORD_CHANGED/);
  t.mock.restoreAll();
  let calls = 0;
  t.mock.method(fs, "fstatSync", (fd) => {
    calls++;
    save(file, current);
    return originalStat(fd);
  });
  assert.throws(() => readJson(file), /TASK_RECORD_CHANGED/);
  assert.equal(calls, 3);
  t.mock.restoreAll();
  if (process.getuid() === 0) {
    fs.chownSync(file, 65534, 65534);
    assert.throws(() => readJson(file), /UNSAFE_TASK_FILE/);
    fs.chownSync(file, 0, 0);
  }
});

test("record and aggregate read budgets stop without losing the unexamined cursor entry", (t) => {
  const { runner, ids } = fixture(t, 6);
  for (const id of ids) {
    const record = runner.load(id);
    record.prompt = "x".repeat(7 * 1024 * 1024);
    save(runner.filename(id), record);
  }
  const page = listTasks(runner, { "--limit": "50" });
  assert.equal(page.coverage.stop_reason, "read_budget");
  assert.ok(page.coverage.record_bytes_read < PAGE_BYTES);
  assert.equal(page.items.length, 4);
  const next = listTasks(runner, { "--limit": "50", "--cursor": page.next_cursor });
  assert.equal(next.items.length, 2);
  assert.equal(new Set([...page.items, ...next.items].map((item) => item.task_id)).size, 6);
  fs.truncateSync(runner.filename(ids[0]), RECORD_BYTES + 1);
  assert.throws(() => inspectTask(runner, ids[0]), /TASK_RECORD_TOO_LARGE/);
});

test("inspect separates stale observations, wall-clock differences and unknown business outcomes", (t) => {
  const { runner, id } = fixture(t);
  const record = runner.load(id);
  Object.assign(record, { state: "ambiguous", createdAt: 10000, startedAt: 9000,
    outputTruncated: false,
    supervisionFailedAt: 20000, callbackDeliveredAt: 30000, attempts: 2,
    notificationKind: "supervision_failure", notificationState: "delivered", resultStatus: "success",
    body: JSON.stringify({ version: 1, callback_id: callback.callback_id, status: "error", output: "PRIVATE-OUTPUT" }),
    executionError: "PRIVATE-RAW-ERROR", deliveryError: "PRIVATE-RAW-ERROR",
    health: { phase: "supervision_failed", observedAt: 1000, lastEventAt: 110000, lastProbeAt: 2000,
      owner: "lease_current", ownerProcess: "alive", journal: "available", assessment: "unavailable",
      progress: "provider_retry", retryUntil: 120000, policy: HEALTH_DEFAULTS } });
  save(runner.filename(id), record);
  save(runner.filename(id, "monitor.json"), { at: 1000, workerAssessment: "suspected", workerSuspectedAt: 500 });
  save(runner.filename(id, "worker.json"), { at: 110000 });
  const before = fs.readFileSync(runner.filename(id));
  const inspected = inspectTask(runner, id);
  assert.equal(inspected.result_status, null);
  assert.equal(inspected.callback.status, "error");
  assert.equal(inspected.callback.retry_count, 2);
  assert.equal(inspected.callback.next_attempt_at, null);
  assert.equal(inspected.callback.delivery_error, "UNKNOWN_RECORDED_CODE");
  assert.equal(inspected.durations.started_to_terminal.ms, null);
  assert.equal(inspected.durations.accepted_to_started.basis, "wall_clock_reversed");
  assert.equal(inspected.durations.supervision_failure_to_delivery.ms, 10000);
  assert.equal(inspected.observations.health.freshness, "stale");
  assert.equal(inspected.observations.worker.freshness, "future_timestamp");
  assert.equal(inspected.observations.worker.age_ms, null);
  assert.equal(inspected.health.agent, "unknown");
  assert.equal(inspected.execution.agent_alive, "unknown");
  assert.equal(inspected.execution.deadlock, "unknown");
  for (const secret of ["PRIVATE-OUTPUT", "PRIVATE-PROMPT", "PRIVATE-RAW-ERROR", callback.callback_id, callback.callback_url])
    assert.equal(JSON.stringify(inspected).includes(secret), false, secret);
  assert.deepEqual(fs.readFileSync(runner.filename(id)), before);
});

test("installed launcher queries do not initialize storage, materialize profiles or run a model without keys", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "task-read-launcher-"));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "toolset");
  const version = path.join(root, "versions/v2.2.0-ricky.1-" + "a".repeat(20));
  fs.mkdirSync(version, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, "runtime"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "bin"), { mode: 0o700 });
  fs.mkdirSync(path.join(version, "node/bin"), { recursive: true, mode: 0o700 });
  fs.copyFileSync(process.execPath, path.join(version, "node/bin/node"));
  const scripts = new URL("../scripts/", import.meta.url);
  for (const name of ["runtime.py", "safety.py", "profiles.py", "diagnostics.py", "task-cli.mjs", "task.mjs", "task-read.mjs", "task-supervisor.mjs"])
    fs.copyFileSync(new URL(name, scripts), path.join(version, name));
  save(path.join(version, "settings.json"), { install_root: root, workspace_id: "readonly-fixture", runtime_profile: "env" });
  save(path.join(root, "owner.json"), { schema: 1, uid: process.getuid(), workspace_id: "readonly-fixture" });
  fs.symlinkSync(path.relative(root, version), path.join(root, "active"));
  fs.writeFileSync(path.join(root, "bin/opencode-task"), `#!/usr/bin/env bash\nexec python3 -B '${root}/active/runtime.py' opencode-task "$@"\n`, { mode: 0o700 });
  const query = (...args) => spawnSync(path.join(root, "bin/opencode-task"), args, { cwd: base,
    env: { PATH: "/usr/bin:/bin", OPENCODE_TASK_POLL_MS: "invalid", OPENCODE_MODULE_CONFIG: "/DO-NOT-OPEN/private-config" }, encoding: "utf8", timeout: 5000 });
  let before = snapshot(root);
  for (const args of [["list"], ["inspect", `task_${"0".repeat(64)}`], ["status", `task_${"0".repeat(64)}`], ["result", `task_${"0".repeat(64)}`]]) {
    const response = query(...args);
    assert.equal(response.status, 1, response.stderr);
    assert.equal(JSON.parse(response.stderr).error.code, "TASK_STORE_MISSING");
  }
  assert.equal(query("--help").status, 0);
  assert.deepEqual(snapshot(root), before);
  const tasks = path.join(root, "runtime/tasks");
  fs.mkdirSync(tasks, { mode: 0o700 });
  save(path.join(tasks, "owner.json"), { schema: 1, uid: process.getuid(), workspace_id: "readonly-fixture" });
  const runner = new TaskRunner({ root: tasks });
  const accepted = runner.submit({ ...intent, key: "readonly", prompt: "PRIVATE-PROMPT", callback, cwd: base });
  const record = runner.load(accepted.task_id);
  Object.assign(record, { state: "outbox", resultStatus: "success", attempts: 0, nextAttemptAt: 0, outputTruncated: false,
    body: JSON.stringify({ version: 1, callback_id: callback.callback_id, status: "success", output: "SEALED RESULT" }) });
  save(runner.filename(accepted.task_id), record);
  before = snapshot(root);
  for (const args of [["list"], ["inspect", accepted.task_id], ["status", accepted.task_id], ["result", accepted.task_id]]) {
    const response = query(...args);
    assert.equal(response.status, 0, response.stderr);
    const value = JSON.parse(response.stdout);
    assert.ok(value);
    assert.equal(response.stdout.includes("PRIVATE-PROMPT"), false);
  }
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, "runtime/module-profiles")), false);
  assert.equal(fs.existsSync(path.join(tasks, "submit.lock")), false);
  fs.unlinkSync(path.join(version, "task-read.mjs"));
  before = snapshot(root);
  const broken = query("list");
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(broken.stderr).error.code, "TASK_MODULE_UNAVAILABLE");
  assert.equal(broken.stderr.includes(root), false);
  assert.deepEqual(snapshot(root), before);
  fs.unlinkSync(path.join(version, "node/bin/node"));
  before = snapshot(root);
  const missingRuntime = query("list");
  assert.equal(missingRuntime.status, 1);
  assert.equal(JSON.parse(missingRuntime.stderr).error.code, "MISSING");
  assert.deepEqual(snapshot(root), before);
});

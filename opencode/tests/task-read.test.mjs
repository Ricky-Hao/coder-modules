import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { TaskRunner, save } from "../scripts/task.mjs";
import { listTasks, readJson, RECORD_BYTES } from "../scripts/task-read.mjs";

const callback = { callback_id: `tcb_${"q".repeat(43)}`, callback_url: "http://localhost:1/api/agents/task-callbacks" };
const intent = { model: { id: 'codex/gpt-6.1-sol', variant: 'max' }, modelConfig: '/fixture/config.json', modelProfile: 'env' };
function fixture(t, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = new TaskRunner({ root, now: () => 100000 });
  const ids = Array.from({ length: count }, (_, index) => runner.submit({ ...intent, key: `key-${index}`, cwd: root,
    prompt: "PRIVATE-PROMPT", callback, ...(index % 2 ? { session: "shared" } : {}) }).task_id);
  for (const method of ["execute", "cancel", "deliver", "write"])
    runner[method] = () => { throw new Error(`unexpected mutation: ${method}`); };
  return { root, runner, ids, id: ids[0] };
}
function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root).sort().map((name) => {
    const file = path.join(root, name), info = fs.statSync(file);
    return [name, info.isDirectory() ? snapshot(file) : [info.mode, info.mtimeMs, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]];
  }));
}

test("list is sorted, filtered, bounded and read only; ordinary local files need no ownership inspection", (t) => {
  const { root, runner, ids } = fixture(t, 24);
  const changed = runner.load(ids[1]); changed.state = "running"; save(runner.filename(ids[1]), changed);
  fs.chmodSync(runner.filename(ids[0]), 0o644);
  const before = snapshot(root), page = listTasks(runner, { "--limit": "2" });
  assert.deepEqual(page.items.map((item) => item.task_id), [...ids].sort().slice(0, 2));
  assert.equal(page.truncated, true); assert.equal(page.records_checked, 2);
  const filtered = listTasks(runner, { "--state": "running", "--session": "shared" });
  assert.deepEqual(filtered.items.map((item) => item.task_id), [ids[1]]);
  runner.status(ids[0]); runner.result(ids[0]);
  assert.deepEqual(snapshot(root), before);
  for (const secret of ["PRIVATE-PROMPT", callback.callback_id, callback.callback_url, '"output"'])
    assert.equal(JSON.stringify(page).includes(secret), false);
  for (const flags of [{ "--limit": "51" }, { "--limit": "0" }, { "--state": "secret" }, { "--session": callback.callback_id }])
    assert.throws(() => listTasks(runner, flags), /INVALID_ARGUMENTS/);
});

test("list caps records; malformed, missing, oversize and non-v3 records report safe errors", (t) => {
  const { root, runner, ids } = fixture(t, 205);
  const page = listTasks(runner, { "--limit": "50", "--state": "ambiguous" });
  assert.equal(page.records_checked, 200); assert.equal(page.truncated, true);
  fs.writeFileSync(runner.filename(ids[0]), '{"PRIVATE-RAW-ERROR":');
  fs.unlinkSync(runner.filename(ids[1]));
  save(runner.filename(ids[2]), { version: 2, id: ids[2] });
  fs.truncateSync(runner.filename(ids[3]), RECORD_BYTES + 1);
  for (const [id, code] of [[ids[0], "INVALID_TASK_RESULT"], [ids[1], "TASK_NOT_FOUND"], [ids[2], "UNSUPPORTED_TASK_RECORD"], [ids[3], "TASK_RECORD_TOO_LARGE"]])
    assert.throws(() => runner.status(id), new RegExp(code));
  const errors = listTasks(runner, { "--state": "ambiguous" }).errors;
  assert.equal(errors.length, 4); assert.equal(JSON.stringify(errors).includes("PRIVATE-"), false);
  const file = path.join(root, "atomic.json"); save(file, { n: 1 }); save(file, { n: 2 });
  assert.deepEqual(readJson(file), { n: 2 });
});

test("status separates callback handoff, request uncertainty and late canonical output", (t) => {
  const { runner, id } = fixture(t), record = runner.load(id);
  Object.assign(record, { state: "ambiguous", dispatchedAt: 10000, startedAt: 11000,
    notificationAt: 20000, callbackDeliveredAt: 30000, notificationKind: "no_progress", callbackState: "delivered",
    body: JSON.stringify({ version: 1, callback_id: callback.callback_id, status: "error", output: "unknown notification" }),
    executionError: "PRIVATE-RAW-ERROR", executionDetail: { reason: "PRIVATE-REASON", cause: "PRIVATE-CAUSE" } });
  save(runner.filename(id), record);
  const before = snapshot(runner.root), inspected = runner.status(id);
  assert.equal(inspected.result_status, null); assert.equal(inspected.callback_status, "error");
  assert.equal(inspected.callback_state, "delivered"); assert.equal(inspected.dispatch_state, "attempted");
  assert.deepEqual(inspected.unknown_scope, ["request"]); assert.equal(inspected.execution_error, "UNKNOWN_RECORDED_CODE");
  assert.equal(inspected.timing.terminal_at, null);
  assert.equal(JSON.stringify(inspected).includes("PRIVATE-"), false); assert.deepEqual(snapshot(runner.root), before);
  record.state = "completed"; record.result = { status: "success", output: "late canonical", truncated: false, at: 40000, source: "watchSession.turn_result", outputSource: "assistant_output" };
  save(runner.filename(id), record);
  assert.equal(runner.result(id).output, "late canonical"); assert.equal(runner.result(id).callback_output, "unknown notification");
});

test("installed query/help ignore old namespace, never initialize or lock, and need no Provider", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "task-read-launcher-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "toolset"), version = path.join(root, "version");
  for (const name of [version, path.join(root, "runtime/tasks"), path.join(root, "bin"), path.join(version, "node/bin")]) fs.mkdirSync(name, { recursive: true, mode: 0o700 });
  fs.copyFileSync(process.execPath, path.join(version, "node/bin/node"));
  for (const name of ["runtime.py", "git_ssh.py", "safety.py", "profiles.py", "diagnostics.py", "task-cli.mjs", "task.mjs", "task-errors.mjs", "task-read.mjs", "task-receipt.mjs"])
    fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(version, name));
  save(path.join(version, "settings.json"), { install_root: root, workspace_id: "readonly-fixture", runtime_profile: "env" });
  fs.writeFileSync(path.join(root, "runtime/tasks", "do-not-scan"), "PRIVATE-OLD-TASK");
  const query = (...args) => spawnSync("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", ...args], { cwd: base,
    env: { PATH: "/usr/bin:/bin", OPENCODE_MODULE_CONFIG: "/DO-NOT-OPEN/private-config" }, encoding: "utf8", timeout: 5000 });
  let before = snapshot(root);
  for (const args of [[], ["--help"], ["-h"], ["launch", "--help"], ["status", "-h"], ["result", "--help"], ["list", "--help"], ["doctor", "--help"], ["recover", "--help"], ["cancel", "--help"]]) {
    const response = query(...args); assert.equal(response.status, 0, response.stderr); assert.match(response.stdout, /approve-all/);
  }
  const missing = query("list"); assert.equal(missing.status, 1); assert.equal(JSON.parse(missing.stderr).error.code, "TASK_STORE_MISSING");
  assert.deepEqual(snapshot(root), before);
  const tasks = path.join(root, "runtime/tasks-v3"); fs.mkdirSync(tasks, { mode: 0o700 });
  const runner = new TaskRunner({ root: tasks }), accepted = runner.submit({ ...intent, key: "readonly", prompt: "PRIVATE-PROMPT", callback, cwd: base });
  before = snapshot(root);
  for (const args of [["list"], ["status", accepted.task_id], ["result", accepted.task_id]]) {
    const response = query(...args); assert.equal(response.status, 0, response.stderr);
    assert.equal(response.stdout.includes("PRIVATE-"), false);
  }
  assert.deepEqual(snapshot(root), before); assert.equal(fs.existsSync(path.join(tasks, "submit.lock")), false);
  assert.equal(fs.existsSync(path.join(root, "runtime/module-profiles")), false);
});

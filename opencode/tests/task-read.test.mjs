import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { TaskStore, save, readJson } from "../scripts/task.mjs";
import { readyTask } from "./task-fixture.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "thin-read-")); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return new TaskStore(root);
}
function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root).sort().map((name) => {
    const file = path.join(root, name), info = fs.statSync(file);
    return [name, info.isDirectory() ? snapshot(file) : [info.mode, info.mtimeMs, fs.readFileSync(file).toString()]];
  }));
}
test("all records filtered before time sort/limit, including active record beyond 200 hashes", (t) => {
  const store = fixture(t), tasks = Array.from({ length: 205 }, (_, index) => readyTask(store, { key: `key-${index}` }, { createdAt: index }));
  const lastHash = [...tasks].sort((a, b) => a.id.localeCompare(b.id)).at(-1);
  lastHash.phase = "dispatched"; lastHash.dispatchedAt = 123; lastHash.sessionKey = "selected"; store.write(lastHash);
  fs.chmodSync(store.filename(tasks[0].id), 0o644);
  const before = snapshot(store.root), list = store.list({ limit: 2 });
  assert.deepEqual(list.items.map((task) => task.task_id), [tasks[204].id, tasks[203].id]); assert.equal(list.truncated, true);
  assert.deepEqual(store.list({ phase: "dispatched", session: "selected" }).items.map((task) => task.task_id), [lastHash.id]);
  store.summary(store.load(lastHash.id), { output: true });
  assert.deepEqual(snapshot(store.root), before); assert.equal(JSON.stringify(list).includes("tcb_"), false);
  assert.equal(JSON.stringify(list).includes("private fixture prompt"), false);
  for (const value of [{ limit: 51 }, { limit: 0 }, { phase: "unknown" }]) assert.throws(() => store.list(value), /INVALID_ARGUMENTS/);
});
test("bad JSON is an error, not missing; per-record list errors remain visible", (t) => {
  const store = fixture(t), tasks = [readyTask(store), readyTask(store), readyTask(store), readyTask(store)];
  fs.writeFileSync(store.filename(tasks[0].id), '{"PRIVATE":'); fs.unlinkSync(store.filename(tasks[1].id));
  save(store.filename(tasks[2].id), { version: 2 }); fs.truncateSync(store.filename(tasks[3].id), 2 * 1024 * 1024 + 1);
  for (const [i, code] of ["INVALID_JSON", "TASK_NOT_FOUND", "INVALID_TASK_RECORD", "RECORD_TOO_LARGE"].entries())
    assert.throws(() => store.load(tasks[i].id), new RegExp(code));
  const list = store.list(); assert.equal(list.errors.length, 4); assert.equal(JSON.stringify(list).includes("PRIVATE"), false);
});
test("query reads no original input; canonical and callback output are independent", (t) => {
  const store = fixture(t), task = readyTask(store); fs.unlinkSync(task.inputFile);
  task.dispatchedAt = 1; task.phase = "finished"; task.output = { text: "late canonical", truncated: false };
  task.result = { status: "success", source: "watchSession.turn_result", outputComplete: true }; store.write(task);
  save(store.filename(task.id, "outbox.json"), { url: "https://private.invalid", state: "delivered", kind: "no_progress",
    body: JSON.stringify({ version: 1, callback_id: `tcb_${"x".repeat(43)}`, status: "error", output: "outcome unknown" }) });
  const before = snapshot(store.root), result = store.summary(store.load(task.id), { output: true });
  assert.equal(result.output, "late canonical"); assert.equal(result.callback_output, "outcome unknown"); assert.equal(result.outcome_unknown, false);
  assert.deepEqual(snapshot(store.root), before); assert.equal(JSON.stringify(result).includes("private.invalid"), false);
});
test("after shared config sync, help/query never create business stores/locks/profiles or read Provider credentials", (t) => {
  const store = fixture(t), root = path.join(store.root, "toolset"), version = path.join(root, "version");
  for (const name of [version, path.join(root, "runtime/tasks"), path.join(root, "bin"), path.join(version, "node/bin")]) fs.mkdirSync(name, { recursive: true, mode: 0o700 });
  fs.copyFileSync(process.execPath, path.join(version, "node/bin/node"));
  for (const name of ["runtime.py", "agent_config.py", "git_ssh.py", "profiles.py", "safety.py", "diagnostics.py", "task-cli.mjs", "task.mjs"])
    fs.copyFileSync(new URL(`../scripts/${name}`, import.meta.url), path.join(version, name));
  save(path.join(version, "settings.json"), { install_root: root, workspace_id: "readonly", runtime_profile: "env" });
  const seed = spawnSync("python3", ["-B", new URL("./agent_config_fixture.py", import.meta.url).pathname, root, version, "readonly"], { encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  const configFixture = JSON.parse(seed.stdout);
  fs.writeFileSync(path.join(root, "runtime/tasks/old-private"), "preserve old namespace");
  const call = (...args) => spawnSync("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", ...args],
    { env: { PATH: configFixture.path, OPENCODE_MODULE_CONFIG: "/DO-NOT-READ/config" }, encoding: "utf8", timeout: 5000 });
  let before = snapshot(root);
  for (const args of [[], ["--version"], ["--help"], ["launch", "--help"], ["recover", "-h"], ["status", "--help"], ["doctor", "--help"]]) {
    const response = call(...args); assert.equal(response.status, 0, response.stderr);
  }
  assert.equal(call("list").status, 1); assert.deepEqual(snapshot(root), before);
  const tasks = path.join(root, "runtime/tasks-v3"); fs.mkdirSync(tasks, { mode: 0o700 });
  const current = new TaskStore(tasks), task = readyTask(current); before = snapshot(root);
  for (const args of [["list"], ["status", task.id], ["result", task.id]]) {
    const response = call(...args); assert.equal(response.status, 0, response.stderr);
    assert.equal(response.stdout.includes("private fixture prompt"), false);
  }
  assert.deepEqual(snapshot(root), before);
  const business = snapshot(tasks);
  for (const args of [["list"], ["status", task.id], ["result", task.id]]) {
    const text = `Rules updated by query ${args[0]}\n`;
    fs.writeFileSync(path.join(configFixture.source, "AGENTS.md"), text);
    for (const gitArgs of [["add", "."], ["commit", "-m", args[0]]]) {
      const committed = spawnSync("git", ["-C", configFixture.source, ...gitArgs], { encoding: "utf8" });
      assert.equal(committed.status, 0, committed.stderr);
    }
    assert.equal(call(...args).status, 0);
    assert.equal(fs.readFileSync(path.join(root, "runtime/config/opencode/AGENTS.md"), "utf8"), text);
    assert.deepEqual(snapshot(tasks), business);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(current.filename(task.id))), ["task.json"]);
  assert.equal(fs.existsSync(path.join(root, "runtime/module-profiles")), false);
  assert.equal(fs.readFileSync(path.join(root, "runtime/tasks/old-private"), "utf8"), "preserve old namespace");
});

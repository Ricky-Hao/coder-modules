import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TaskStore, TaskError, hash, save } from "../scripts/task.mjs";
import { launchTask, git as safeGit } from "../scripts/task-launch.mjs";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
Object.assign(process.env, { CODEX_BASE_URL: "https://codex.example.invalid/v1", CODEX_API_KEY: "synthetic",
  COPILOT_BASE_URL: "https://copilot.example.invalid/v1", COPILOT_API_KEY: "synthetic" });
for (const name of ["CONTEXT7", "FIRECRAWL", "GITHUB", "GITHUB_ACTIONS"]) process.env[name + "_MCP_ENABLED"] = "0";
delete process.env.OPENCODE_MODULE_CONFIG;
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "thin-launch-")); fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "toolset"), version = path.join(root, "version"), tasks = path.join(root, "runtime/tasks-v3");
  for (const dir of [version, tasks]) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  for (const name of ["runtime.py", "git_ssh.py", "profiles.py", "profile-env.json", "safety.py"]) fs.copyFileSync(path.join(scripts, name), path.join(version, name));
  for (const name of ["home", "config", "data", "cache", "state", "tmp"]) fs.mkdirSync(path.join(root, "runtime", name), { mode: 0o700 });
  save(path.join(root, "owner.json"), { schema: 1, uid: process.getuid(), workspace_id: "launch-fixture" });
  save(path.join(version, "settings.json"), { install_root: root, workspace_id: "launch-fixture", runtime_profile: "env" });
  const origin = path.join(base, "origin"), repo = path.join(base, "repo"); fs.mkdirSync(origin); fs.mkdirSync(repo);
  git(origin, "init", "--bare", "--initial-branch=main"); git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "fixture@example.invalid"); git(repo, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(repo, "tracked"), "first"); git(repo, "add", "tracked"); git(repo, "commit", "-m", "first");
  git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main"); const old = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "tracked"), "latest"); git(repo, "commit", "-am", "latest"); git(repo, "push", "origin", "main");
  const latest = git(repo, "rev-parse", "HEAD"); git(repo, "checkout", "-b", "unrelated", old);
  fs.writeFileSync(path.join(repo, "dirty"), "keep unrelated work");
  const store = new TaskStore(tasks); let starts = 0;
  const spawnControl = async (id) => {
    starts++; const task = store.load(id); task.workerStartedAt = store.now(); store.write(task); return store.summary(task);
  };
  const input = { schema_version: 1, key: "first", repo_path: repo, branch: "feat/first", worktree: "work-first", prompt: "bounded task",
    callback: { callback_id: `tcb_${"x".repeat(43)}`, callback_url: "https://callback.example.invalid/api/agents/task-callbacks", native_extra: "kept only in original input" } };
  const launch = (value = input, flags = {}, extra = {}) => {
    const file = path.join(base, `${value.key}.json`); save(file, value);
    return launchTask(store, { "--input-file": file, ...flags }, { version, spawnControl, ...extra });
  };
  const terminal = (id) => {
    const task = store.load(id); task.phase = "finished"; task.result = { status: "success", source: "turn.result", outputComplete: true };
    task.handle = { backend: "acpx-shared", cwd: task.cwd, sessionKey: task.sessionKey, acpxRecordId: "record", backendSessionId: "session" };
    store.write(task); return task;
  };
  return { base, root, tasks, store, version, repo, origin, input, old, latest, launch, terminal, starts: () => starts };
}
test("fresh origin base, preserved dirty checkout, original input only and read-only reuse", async (t) => {
  const f = fixture(t), result = await f.launch(); assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.accepted, true); assert.equal(result.base_sha, f.latest); assert.equal(result.worktree, path.join(f.base, "work-first"));
  assert.equal(git(result.worktree, "rev-parse", "HEAD"), f.latest); assert.equal(git(f.repo, "rev-parse", "HEAD"), f.old);
  assert.equal(fs.readFileSync(path.join(f.repo, "dirty"), "utf8"), "keep unrelated work");
  assert.equal(result.permissions.mode, "approve-all"); assert.equal(result.selection.variant, "max");
  const task = f.store.load(result.task_id), before = fs.readFileSync(f.store.filename(task.id));
  assert.equal(JSON.stringify(task).includes(f.input.prompt), false); assert.equal(JSON.stringify(task).includes("tcb_"), false);
  assert.equal(task.inputFile, path.join(f.base, "first.json"));
  assert.deepEqual(fs.readdirSync(f.tasks), [task.id]);
  assert.equal((await f.launch()).request_id, result.request_id); assert.equal(f.starts(), 1);
  assert.deepEqual(fs.readFileSync(f.store.filename(task.id)), before);
  assert.equal((await f.launch({ ...f.input, prompt: "different" })).error.code, "LAUNCH_CONFLICT");
});
test("same key before first ACK only reads; first control owns all later task writes", async (t) => {
  const f = fixture(t); let reached, release;
  const ready = new Promise((resolve) => { reached = resolve; }), wait = new Promise((resolve) => { release = resolve; });
  const running = f.launch(f.input, {}, { spawnControl: async (id) => {
    reached(); await wait; const task = f.store.load(id); task.workerStartedAt = 1; task.phase = "dispatched"; task.dispatchedAt = 2;
    task.output = { text: "worker wrote this" }; f.store.write(task); return f.store.summary(task);
  } });
  await ready; const reused = await f.launch();
  assert.equal(reused.reused, true); assert.equal(reused.accepted, false); assert.equal(reused.phase, "ready");
  release(); const result = await running;
  assert.equal(result.dispatch_state, "attempted"); assert.equal(f.store.load(result.task_id).output.text, "worker wrote this");
});
test("same key concurrent preparation has one Git prepare and one worker", async (t) => {
  const f = fixture(t), results = await Promise.all([f.launch(), f.launch()]);
  assert.equal(f.starts(), 1); assert.equal(results.filter((value) => value.accepted).length >= 1, true);
  const again = await f.launch(); assert.equal(again.reused, true); assert.equal(f.starts(), 1);
});
test("one exclusive successor; preserved selection/permissions/base, timeout defaults each round", async (t) => {
  const f = fixture(t), first = await f.launch({ ...f.input, permissions: { mode: "deny-all", policy: { autoApprove: ["read", "search"] } }, no_progress_timeout_seconds: 5 });
  f.terminal(first.task_id);
  const follow = (key) => f.launch({ schema_version: 1, key, prompt: "next", callback: f.input.callback }, { "--continue-from": first.task_id });
  const results = await Promise.all([follow("a"), follow("b")]);
  const winner = results.find((value) => value.accepted), loser = results.find((value) => value.error);
  assert.equal(loser.error.code, "CONTINUE_NOT_LATEST"); assert.equal(f.starts(), 2);
  assert.equal(winner.permissions.mode, "deny-all"); assert.deepEqual(winner.permissions.auto_approve, ["read", "search"]);
  assert.equal(winner.no_progress_timeout_seconds, 900); assert.equal(winner.base_sha, first.base_sha); assert.equal(winner.session, first.session);
  assert.equal(JSON.parse(fs.readFileSync(f.store.filename(first.task_id, "successor.json"))).task_id, winner.task_id);
  assert.equal((await follow("c")).error.code, "CONTINUE_NOT_LATEST");
});
test("interrupted successor retains its exclusive claim; no new key or automatic completion", async (t) => {
  const f = fixture(t), first = await f.launch(); f.terminal(first.task_id);
  const original = f.store.write.bind(f.store);
  f.store.write = (task) => { if (task.continueFrom && task.phase === "ready") throw new TaskError("TASK_WRITE_FAILED", { stage: "storage" }); original(task); };
  const value = { schema_version: 1, key: "follow", prompt: "next", callback: f.input.callback }, flags = { "--continue-from": first.task_id };
  const failed = await f.launch(value, flags); f.store.write = original;
  assert.equal(failed.error.code, "TASK_WRITE_FAILED");
  assert.equal((await f.launch(value, flags)).error.code, "PREPARATION_INCOMPLETE");
  assert.equal((await f.launch({ ...value, key: "new" }, flags)).error.code, "CONTINUE_NOT_LATEST"); assert.equal(f.starts(), 1);
});
test("Git failure and worktree conflict retain preparation; duplicate never refetches", async (t) => {
  const f = fixture(t); git(f.repo, "remote", "set-url", "origin", "/synthetic/unavailable");
  const failed = await f.launch(); assert.equal(failed.error.code, "GIT_FAILED"); assert.equal(failed.phase, "preparing");
  assert.equal(failed.step, "fetch"); assert.equal(failed.worktree, null); assert.equal(failed.dispatch_state, "not_reached");
  const record = fs.readFileSync(f.store.filename(failed.task_id));
  git(f.repo, "remote", "set-url", "origin", f.origin);
  assert.equal((await f.launch()).error.code, "PREPARATION_INCOMPLETE"); assert.deepEqual(fs.readFileSync(f.store.filename(failed.task_id)), record);
  assert.equal(f.starts(), 0);
  fs.mkdirSync(path.join(f.base, "existing"));
  const conflict = await f.launch({ ...f.input, key: "conflict", worktree: "existing" }); assert.equal(conflict.error.code, "GIT_OBJECT_CONFLICT");
});
test("ACK unknown preserves original request and never retries worker", async (t) => {
  const f = fixture(t), failed = await f.launch(f.input, {}, { spawnControl: async () => { throw new TaskError("CONTROL_ACK_UNKNOWN", { stage: "control", field: "control_ack" }); } });
  assert.equal(failed.dispatch_state, "unknown"); assert.equal(failed.accepted, false);
  const reused = await f.launch(); assert.equal(reused.request_id, failed.request_id); assert.equal(f.starts(), 0);
});
test("private file modes, links, symlink ancestors and callback-shaped fields fail before claim", async (t) => {
  const f = fixture(t), file = path.join(f.base, "private.json"); save(file, f.input); fs.chmodSync(file, 0o644);
  const call = () => launchTask(f.store, { "--input-file": file }, { version: f.version, spawnControl: () => assert.fail("no dispatch") });
  assert.equal((await call()).error.code, "PRIVATE_INPUT_INVALID"); fs.chmodSync(file, 0o600);
  fs.linkSync(file, file + ".link"); assert.equal((await call()).error.code, "PRIVATE_INPUT_INVALID"); fs.unlinkSync(file + ".link");
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.base, "missing"), file); assert.equal((await call()).error.code, "PRIVATE_INPUT_INVALID");
  save(path.join(f.base, "real.json"), f.input); fs.symlinkSync(f.base, path.join(f.base, "alias"));
  const alias = await launchTask(f.store, { "--input-file": path.join(f.base, "alias/real.json") }, { version: f.version });
  assert.equal(alias.error.code, "PRIVATE_INPUT_INVALID");
  for (const input of [{ ...f.input, branch: "../bad" }, { ...f.input, key: "tcb_bad" }, { ...f.input, prompt: f.input.callback.callback_id },
    { ...f.input, extra: true }, { ...f.input, permissions: { mode: "deny-all", policy: { autoApprove: [f.input.callback.callback_url] } } }]) {
    assert.ok((await f.launch(input)).error);
  }
  assert.deepEqual(fs.readdirSync(f.tasks), []);
});
test("custom base fresh fetch preserves unrelated FETCH_HEAD; stderr never projected", async (t) => {
  const f = fixture(t); git(f.origin, "update-ref", "refs/heads/user/stable", f.old);
  const fetchHead = path.join(f.repo, ".git/FETCH_HEAD"); fs.writeFileSync(fetchHead, "unrelated");
  const result = await f.launch({ ...f.input, base: "user/stable" }); assert.equal(result.base_sha, f.old);
  assert.equal(fs.readFileSync(fetchHead, "utf8"), "unrelated");
  await assert.rejects(safeGit("/PRIVATE-REMOTE", ["status"], "prepare", "repo_path"), (error) => error.code === "GIT_FAILED" && !JSON.stringify(error).includes("PRIVATE"));
});

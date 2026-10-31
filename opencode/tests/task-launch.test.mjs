import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TaskRunner } from "../scripts/task.mjs";
import { launchTask } from "../scripts/task-launch.mjs";

const scripts = fileURLToPath(new URL("../scripts", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "task-launch-"));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "toolset"), version = path.join(root, "version"), tasks = path.join(root, "runtime/tasks");
  for (const dir of [root, version, path.join(root, "runtime"), tasks]) fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of ["home", "config", "data", "cache", "state", "tmp"])
    fs.mkdirSync(path.join(root, "runtime", name), { mode: 0o700 });
  for (const name of ["runtime.py", "profiles.py", "profile-env.json", "safety.py"])
    fs.copyFileSync(path.join(scripts, name), path.join(version, name));
  write(path.join(root, "owner.json"), { schema: 1, uid: process.getuid(), workspace_id: "launch-fixture" });
  write(path.join(version, "settings.json"), { install_root: root, workspace_id: "launch-fixture", runtime_profile: "env" });
  const origin = path.join(base, "origin"), repo = path.join(base, "repo");
  fs.mkdirSync(origin); git(origin, "init", "--bare", "--initial-branch=main");
  fs.mkdirSync(repo); git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "fixture@example.invalid"); git(repo, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(repo, "file"), "first\n"); git(repo, "add", "file"); git(repo, "commit", "-m", "first");
  git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
  const old = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "file"), "latest\n"); git(repo, "commit", "-am", "latest"); git(repo, "push", "origin", "main");
  const latest = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", "unrelated", old);
  git(repo, "update-ref", "refs/heads/main", old);
  git(repo, "update-ref", "refs/remotes/origin/main", old);
  fs.writeFileSync(path.join(repo, "dirty"), "keep unrelated work");
  const runner = new TaskRunner({ root: tasks });
  let launches = 0;
  const options = { version, spawnWorker: async () => { launches++; } };
  const input = { schema_version: 1, key: "new", repo_path: repo, branch: "feat/new", worktree: "new-work",
    prompt: "Do the bounded task.", callback: { callback_id: `tcb_${"x".repeat(43)}`, callback_url: "https://callback.example.invalid/api/agents/task-callbacks", expires_at: "native-registration-extra" } };
  const inputFile = path.join(base, "input.json");
  const launch = async (value = input, flags = {}, extra = {}) => {
    write(inputFile, value);
    return launchTask(runner, { "--input-file": inputFile, ...flags }, { ...options, ...extra });
  };
  const saved = (result) => JSON.parse(fs.readFileSync(path.join(tasks, ".launches", `${result.task_id}.json`)));
  return { base, root, version, tasks, origin, repo, old, latest, runner, input, inputFile, options, launch, saved, launches: () => launches };
}

// 选择子进程只获得合成凭据；这些测试不启动 ACP/Provider。
process.env.CODEX_BASE_URL = "https://codex.example.invalid/v1";
process.env.CODEX_API_KEY = "synthetic-codex";
process.env.COPILOT_BASE_URL = "https://copilot.example.invalid/v1";
process.env.COPILOT_API_KEY = "synthetic-copilot";
for (const name of ["CONTEXT7", "FIRECRAWL", "GITHUB", "GITHUB_ACTIONS"]) process.env[name + "_MCP_ENABLED"] = "0";
delete process.env.OPENCODE_MODULE_CONFIG;

test("new: fetched main, dirty checkout preserved, private intent and same-key reuse", async (t) => {
  const f = fixture(t), result = await f.launch();
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.accepted, true); assert.equal(result.base_sha, f.latest);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.old);
  assert.equal(git(f.repo, "rev-parse", "main"), f.old);
  assert.equal(fs.readFileSync(path.join(f.repo, "dirty"), "utf8"), "keep unrelated work");
  assert.equal(result.worktree, path.join(f.base, "new-work"));
  assert.deepEqual(result.selection, { provider: "codex", model: "gpt-6.1-sol", variant: "max", status: "resolved" });
  assert.equal(result.permissions.mode, "deny-all");
  assert.equal(JSON.stringify(result).includes("tcb_"), false);
  assert.equal(JSON.stringify(f.saved(result)).includes(f.input.prompt), false);
  assert.equal(fs.statSync(path.join(f.tasks, ".launches", `${result.task_id}.json`)).mode & 0o777, 0o600);
  const again = await f.launch();
  assert.equal(again.request_id, result.request_id); assert.equal(again.reused, true);
  assert.equal((await f.launch({ ...f.input, prompt: "changed" })).error.code, "LAUNCH_CONFLICT");
});

test("continue: terminal proof, same session/context intent, explicit permission policy, latest-round guard", async (t) => {
  const f = fixture(t), original = await f.launch();
  const input = { schema_version: 1, key: "next", prompt: "Incremental fix.", callback: { ...f.input.callback, callback_id: `tcb_${"y".repeat(43)}` } };
  const flags = { "--continue-from": original.task_id };
  assert.equal((await f.launch(input, flags)).error.code, "CONTINUE_BUSY_OR_UNKNOWN");
  const task = f.runner.load(original.task_id);
  task.handle = { backend: 'acpx-shared', cwd: task.cwd, sessionKey: task.sessionKey,
    acpxRecordId: 'fixture-record', backendSessionId: 'fixture-session' };
  f.runner.seal(task, "success", "done", "turn.result");
  const switched = await f.launch({ ...input, key: "switch", variant: "low" }, flags);
  assert.equal(switched.error.code, "SESSION_MODEL_CONFLICT");
  const next = await f.launch({ ...input, permissions: { mode: "approve-reads", policy: { autoDeny: ["edit"] } } }, flags);
  assert.equal(next.error, undefined, JSON.stringify(next));
  assert.equal(next.session, original.session); assert.equal(next.worktree, original.worktree);
  assert.equal(next.selection.variant, "max"); assert.equal(next.permissions.mode, "approve-reads");
  assert.equal((await f.launch({ ...input, key: "fork" }, flags)).error.code, "CONTINUE_NOT_LATEST");
  assert.equal((await f.launch()).request_id, original.request_id);
  assert.throws(() => f.runner.submit({ key: "bypass", cwd: next.worktree, prompt: "bypass", callback: f.input.callback,
    session: next.session, ...f.saved(next).selection }), /SESSION_LAUNCH_REQUIRED/);
  const predispatch = f.runner.load(next.task_id);
  f.runner.seal(predispatch, "cancelled", "queued cancellation", "queued_cancellation");
  const afterCancel = await f.launch({ ...input, key: "after-cancel" }, { "--continue-from": next.task_id });
  assert.equal(afterCancel.error, undefined, JSON.stringify(afterCancel));
  assert.equal(f.runner.load(afterCancel.task_id).continuationHandle.backendSessionId, 'fixture-session');
});

test("legacy and unknown terminal do not authorize continuation", async (t) => {
  const f = fixture(t);
  const legacy = f.runner.submit({ key: "legacy", cwd: f.repo, prompt: "legacy", callback: f.input.callback });
  const next = { schema_version: 1, key: "next", prompt: "next", callback: f.input.callback };
  assert.equal((await f.launch(next, { "--continue-from": legacy.task_id })).error.code, "LAUNCH_METADATA_REQUIRED");
  const original = await f.launch();
  const task = f.runner.load(original.task_id);
  task.state = "ambiguous"; task.resultStatus = "error"; task.terminalSource = "supervision_failure"; f.runner.write(task);
  assert.equal((await f.launch(next, { "--continue-from": original.task_id })).error.code, "CONTINUE_BUSY_OR_UNKNOWN");
});

test("all validation precedes Git writes; conflicts and private-file boundaries", async (t) => {
  const f = fixture(t), before = git(f.repo, "show-ref");
  for (const change of [{ branch: "../escape" }, { branch: "--option" }, { worktree: "../escape" }, { worktree: "/absolute" },
    { base_sha: f.old }, { permissions: { mode: "anything" } }, { prompt: f.input.callback.callback_id },
    { prompt: `unrelated bearer tcb_${'z'.repeat(43)}` },
    { callback: { ...f.input.callback, callback_url: "https://user:secret@example.invalid/api/agents/task-callbacks" } },
    { callback: { ...f.input.callback, callback_url: "https://CALLBACK.EXAMPLE.INVALID:443/api/agents/task-callbacks" },
      prompt: "https://CALLBACK.EXAMPLE.INVALID:443/api/agents/task-callbacks" },
    { provider: "unknown" }, { model: "unknown" }, { variant: "unknown" }]) {
    const value = await f.launch({ ...f.input, key: `invalid-${digest(JSON.stringify(change)).slice(0, 12)}`, ...change });
    assert.equal(value.accepted, false); assert.ok(value.error, JSON.stringify(change));
    assert.equal(git(f.repo, "show-ref"), before);
  }
  fs.mkdirSync(path.join(f.base, "new-work"));
  assert.equal((await f.launch()).error.code, "LAUNCH_OBJECT_CONFLICT");
  fs.rmdirSync(path.join(f.base, "new-work"));
  git(f.repo, "branch", "feat/new");
  assert.equal((await f.launch()).error.code, "LAUNCH_OBJECT_CONFLICT");
  write(f.inputFile, f.input); fs.chmodSync(f.inputFile, 0o644);
  assert.equal((await launchTask(f.runner, { "--input-file": f.inputFile }, f.options)).error.code, "UNSAFE_TASK_FILE");
  fs.chmodSync(f.inputFile, 0o600);
  const linked = path.join(f.base, "linked.json"); fs.linkSync(f.inputFile, linked);
  assert.equal((await launchTask(f.runner, { "--input-file": linked }, f.options)).error.code, "UNSAFE_TASK_FILE");
  fs.unlinkSync(linked); fs.symlinkSync(f.inputFile, linked);
  assert.equal((await launchTask(f.runner, { "--input-file": linked }, f.options)).error.code, "UNSAFE_TASK_FILE");
  fs.unlinkSync(linked); execFileSync("mkfifo", [linked]);
  assert.equal((await launchTask(f.runner, { "--input-file": linked }, f.options)).error.code, "UNSAFE_TASK_FILE");
  const parentLink = path.join(f.base, 'parent-link'); fs.symlinkSync(f.base, parentLink);
  assert.equal((await launchTask(f.runner, { "--input-file": path.join(parentLink, 'input.json') }, f.options)).error.code, "UNSAFE_TASK_FILE");
  fs.writeFileSync(f.inputFile, 'x'.repeat(1048576 + 16385));
  assert.equal((await launchTask(f.runner, { "--input-file": f.inputFile }, f.options)).error.code, "TASK_RECORD_TOO_LARGE");
  write(f.inputFile, f.input);
  if (process.getuid() === 0) {
    fs.chownSync(f.inputFile, 65534, 65534);
    assert.equal((await launchTask(f.runner, { "--input-file": f.inputFile }, f.options)).error.code, "UNSAFE_TASK_FILE");
    fs.chownSync(f.inputFile, 0, 0);
  }
});

test("fetch failure does not use cached main and never returns raw stderr", async (t) => {
  const f = fixture(t);
  git(f.repo, "remote", "set-url", "origin", "https://user:RAW-REMOTE-SECRET@127.0.0.1:1/repo");
  const result = await f.launch();
  assert.equal(result.error.code, "GIT_FETCH_FAILED"); assert.equal(result.base_sha, null);
  assert.equal(result.accepted, false); assert.equal(JSON.stringify(result).includes("RAW-REMOTE"), false);
  assert.equal(git(f.repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"), f.old);
});

test("interruption after successful fetch fixes base, branch/worktree recovery verifies ownership", async (t) => {
  const f = fixture(t);
  let interrupted = false;
  const first = await f.launch(f.input, {}, { checkpoint: (stage) => {
    if (stage === "fetch" && !interrupted) {
      const file = path.join(f.tasks, ".launches", `task_${digest(f.input.key)}.json`);
      if (JSON.parse(fs.readFileSync(file)).durations.fetch !== undefined) { interrupted = true; throw new Error("interrupted"); }
    }
  } });
  assert.equal(first.accepted, false); assert.equal(interrupted, true);
  git(f.origin, "update-ref", "refs/heads/main", f.old);
  let branchStop = false;
  const second = await f.launch(f.input, {}, { checkpoint: (stage) => {
    if (stage === "worktree_directory" && !branchStop) { branchStop = true; throw new Error("interrupted"); }
  } });
  assert.equal(second.base_sha, f.latest); assert.equal(second.accepted, false);
  const final = await f.launch();
  assert.equal(final.error, undefined, JSON.stringify(final)); assert.equal(final.base_sha, f.latest);
});

test("prepared key and session cannot be occupied by low-level submit; directory publish recovers", async (t) => {
  const f = fixture(t);
  let stopped = false;
  const partial = await f.launch(f.input, {}, { checkpoint: (stage) => {
    const file = path.join(f.tasks, ".launches", `task_${digest(f.input.key)}.json`);
    if (stage === "worktree_directory" && JSON.parse(fs.readFileSync(file)).worktreeIdentity && !stopped) {
      stopped = true; throw new Error("interrupted after durable staging identity");
    }
  } });
  assert.equal(partial.accepted, false); assert.equal(stopped, true);
  assert.throws(() => f.runner.submit({ key: f.input.key, cwd: f.repo, prompt: "different", callback: f.input.callback }), /SUBMIT_CONFLICT/);
  assert.throws(() => f.runner.bindSession({ cwd: partial.worktree, session: partial.session, ...f.saved(partial).selection }), /SESSION_LAUNCH_REQUIRED/);
  const resumed = await f.launch();
  assert.equal(resumed.error, undefined, JSON.stringify(resumed)); assert.equal(resumed.reused, true);
  assert.equal(fs.existsSync(f.saved(resumed).worktreeStaging), false);
});

test("Git routing environment cannot redirect an authorized repository", async (t) => {
  const f = fixture(t);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = f.origin;
  try {
    const launched = await f.launch();
    assert.equal(launched.error, undefined, JSON.stringify(launched));
    assert.equal(f.saved(launched).repository.common, path.join(f.repo, '.git'));
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
  }
});

test("submit response loss recovers original task without invoking submit again", async (t) => {
  const f = fixture(t), submit = f.runner.submit.bind(f.runner);
  f.runner.submit = (input) => { submit(input); throw new Error("lost response"); };
  const first = await f.launch();
  assert.equal(first.accepted, true); assert.ok(first.request_id);
  f.runner.submit = () => { throw new Error("MUST NOT RESUBMIT"); };
  const retry = await f.launch();
  assert.equal(retry.error, undefined, JSON.stringify(retry)); assert.equal(retry.request_id, first.request_id);
});

test("new selections resolve provider/model defaults and standalone variant", async (t) => {
  const f = fixture(t);
  for (const [name, extra, provider, model, variant] of [
    ["provider", { provider: "copilot" }, "copilot", "gpt-6.1-sol", "max"],
    ["model", { model: "gpt-6-astra" }, "codex", "gpt-6-astra", "medium"],
    ["variant", { variant: "low" }, "codex", "gpt-6.1-sol", "low"],
  ]) {
    const result = await f.launch({ ...f.input, key: name, branch: `feat/${name}`, worktree: name, ...extra });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.selection, { provider, model, variant, status: "resolved" });
  }
  const original = await f.launch({ ...f.input, key: 'high', branch: 'feat/high', worktree: 'high', variant: 'high' });
  const task = f.runner.load(original.task_id);
  task.handle = { backend: 'acpx-shared', cwd: task.cwd, sessionKey: task.sessionKey,
    acpxRecordId: 'fixture-record', backendSessionId: 'fixture-session' };
  f.runner.seal(task, 'success', 'done', 'turn.result');
  const same = await f.launch({ schema_version: 1, key: 'same-model', prompt: 'follow-up', callback: f.input.callback,
    provider: 'codex', model: 'gpt-6.1-sol' }, { '--continue-from': original.task_id });
  assert.equal(same.error, undefined, JSON.stringify(same)); assert.equal(same.selection.variant, 'high');
});

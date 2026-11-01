import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TaskRunner } from "../scripts/task.mjs";
import { launchTask, git as launchGit } from "../scripts/task-launch.mjs";
import { TaskError } from "../scripts/task-errors.mjs";

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
  for (const name of ["runtime.py", "git_ssh.py", "profiles.py", "profile-env.json", "safety.py"])
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
  const options = { version, spawnControl: async () => { launches++; } };
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
  assert.equal(result.base, "main"); assert.equal(f.saved(result).base, "main");
  assert.match(result.base_sha, /^[a-f0-9]{40}$/);
  assert.equal(git(result.worktree, "rev-parse", "HEAD"), result.base_sha);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.old);
  assert.equal(git(f.repo, "rev-parse", "main"), f.old);
  assert.equal(fs.readFileSync(path.join(f.repo, "dirty"), "utf8"), "keep unrelated work");
  assert.equal(result.worktree, path.join(f.base, "new-work"));
  assert.deepEqual(result.selection, { provider: "codex", model: "gpt-6.1-sol", variant: "max", status: "resolved" });
  assert.equal(result.permissions.mode, "approve-all");
  assert.equal(JSON.stringify(result).includes("tcb_"), false);
  assert.equal(JSON.stringify(f.saved(result)).includes(f.input.prompt), false);
  assert.equal(fs.statSync(path.join(f.tasks, ".launches", `${result.task_id}.json`)).mode & 0o777, 0o600);
  const again = await f.launch();
  assert.equal(again.request_id, result.request_id); assert.equal(again.reused, true);
  assert.equal((await f.launch({ ...f.input, prompt: "changed" })).error.code, "LAUNCH_CONFLICT");
});

test("自选含斜线的远端 base：新 key fresh fetch，同 key 保留原 SHA 和 request", async (t) => {
  const f = fixture(t), base = "rickyhao/stable", remote = `refs/heads/${base}`;
  git(f.origin, "update-ref", remote, f.old);
  git(f.repo, "update-ref", `refs/remotes/origin/${base}`, f.old);
  const fetchHead = path.join(f.repo, ".git/FETCH_HEAD"); fs.writeFileSync(fetchHead, "unrelated fetch\n");
  const input = { ...f.input, base }, first = await f.launch(input);
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.equal(first.base, base); assert.equal(first.base_sha, f.old);
  assert.equal(git(first.worktree, "rev-parse", "HEAD"), f.old);
  const saved = f.saved(first), fetched = `refs/opencode-launch/${saved.id}`;
  assert.equal(saved.base, base); assert.equal(saved.base_sha, f.old);
  assert.equal(git(f.repo, "rev-parse", fetched), f.old);
  git(f.origin, "update-ref", remote, f.latest);
  const retry = await f.launch(input);
  assert.equal(retry.request_id, first.request_id); assert.equal(retry.reused, true);
  assert.equal(retry.base, base); assert.equal(retry.base_sha, f.old);
  assert.equal(git(f.repo, "rev-parse", fetched), f.old);
  assert.equal((await f.launch({ ...input, base: "main" })).error.code, "LAUNCH_CONFLICT");
  const next = await f.launch({ ...input, key: "fresh", branch: "feat/fresh", worktree: "fresh-work" });
  assert.equal(next.error, undefined, JSON.stringify(next));
  assert.equal(next.base, base); assert.equal(next.base_sha, f.latest);
  assert.match(next.base_sha, /^[a-f0-9]{40}$/);
  assert.equal(git(next.worktree, "rev-parse", "HEAD"), f.latest);
  assert.equal(fs.readFileSync(fetchHead, "utf8"), "unrelated fetch\n");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.old);
  assert.equal(fs.readFileSync(path.join(f.repo, "dirty"), "utf8"), "keep unrelated work");
});

test("base 输入拒绝无效名称、参数注入和 revision 表达式，且不领取 key 或修改 Git", async (t) => {
  const f = fixture(t), before = git(f.repo, "show-ref");
  for (const base of [null, 1, {}, [], "", "HEAD", "-main", "--upload-pack=evil", "main other", "main\nother",
    "../main", "a..b", "a//b", "a/.hidden", "a.lock", "a/b.lock", "a.", "a/", "/main", "a\\b",
    "main~1", "main^", "main^{commit}", "main:refs/heads/escape", "@{-1}", "a?b", "a*b", "a[b", "a".repeat(241),
    f.input.callback.callback_id, f.input.callback.callback_url]) {
    const result = await f.launch({ ...f.input, base });
    assert.equal(result.error?.code, "INVALID_LAUNCH_INPUT", JSON.stringify(base));
    assert.equal(result.accepted, false);
  }
  assert.equal(git(f.repo, "show-ref"), before);
  assert.equal(fs.existsSync(path.join(f.tasks, ".launches")), false);
});

test("不存在的远端 base 不使用同名缓存或 tag；失败后同 key 仍 fail closed", async (t) => {
  const f = fixture(t), base = "rickyhao/missing", input = { ...f.input, base };
  git(f.repo, "update-ref", `refs/remotes/origin/${base}`, f.latest);
  git(f.origin, "update-ref", `refs/tags/${base}`, f.latest);
  const before = git(f.repo, "show-ref"), failed = await f.launch(input);
  assert.equal(failed.error.code, "GIT_FETCH_FAILED"); assert.equal(failed.stage, "fetch");
  assert.equal(failed.base, base); assert.equal(failed.base_sha, null); assert.equal(failed.accepted, false);
  assert.equal(git(f.repo, "show-ref"), before);
  assert.equal(fs.existsSync(path.join(f.base, "new-work")), false);
  const file = path.join(f.tasks, ".launches", `${failed.task_id}.json`), bytes = fs.readFileSync(file);
  git(f.origin, "update-ref", `refs/heads/${base}`, f.latest);
  assert.equal((await f.launch(input)).error.code, "GIT_PREPARATION_INTERRUPTED");
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(git(f.repo, "show-ref"), before); assert.equal(f.launches(), 0);
});

test("自选 base 的续接保留原 SHA、worktree 和 session，不接受 base 或重新 fetch", async (t) => {
  const f = fixture(t), base = "rickyhao/stable";
  git(f.origin, "update-ref", `refs/heads/${base}`, f.old);
  const original = await f.launch({ ...f.input, base }), task = f.runner.load(original.task_id);
  task.handle = { backend: "acpx-shared", cwd: task.cwd, sessionKey: task.sessionKey,
    acpxRecordId: "fixture-record", backendSessionId: "fixture-session" };
  f.runner.seal(task, "success", "done", "turn.result");
  fs.writeFileSync(path.join(original.worktree, "file"), "task commit\n");
  git(original.worktree, "commit", "-am", "task change");
  const head = git(original.worktree, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(original.worktree, "dirty"), "keep task work");
  git(f.origin, "update-ref", `refs/heads/${base}`, f.latest);
  fs.renameSync(f.origin, f.origin + "-unavailable");
  const input = { schema_version: 1, key: "next", prompt: "next", callback: f.input.callback };
  const flags = { "--continue-from": original.task_id };
  for (const value of [base, "main"])
    assert.equal((await f.launch({ ...input, base: value }, flags)).error.code, "INVALID_LAUNCH_INPUT");
  const next = await f.launch(input, flags);
  assert.equal(next.error, undefined, JSON.stringify(next));
  assert.equal(next.base, base); assert.equal(next.base_sha, f.old);
  assert.equal(next.worktree, original.worktree); assert.equal(next.session, original.session);
  assert.equal(f.runner.load(next.task_id).continuationHandle.backendSessionId, "fixture-session");
  assert.equal(git(next.worktree, "rev-parse", "HEAD"), head);
  assert.equal(fs.readFileSync(path.join(next.worktree, "dirty"), "utf8"), "keep task work");
});

test("v3 缺失 base 是损坏记录，不提供旧格式 fallback", async (t) => {
  const f = fixture(t), original = await f.launch();
  const launchFile = path.join(f.tasks, ".launches", `${original.task_id}.json`);
  const taskFile = path.join(f.tasks, original.task_id, "task.json"), record = f.saved(original);
  delete record.base; write(launchFile, record);
  const launchBytes = fs.readFileSync(launchFile), taskBytes = fs.readFileSync(taskFile);
  const retry = await f.launch();
  assert.equal(retry.error.code, "INVALID_TASK_RESULT");
  assert.equal(retry.base, null); assert.equal(retry.request_id, null);
  assert.deepEqual(fs.readFileSync(launchFile), launchBytes); assert.deepEqual(fs.readFileSync(taskFile), taskBytes);
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
  const predispatch = f.runner.load(next.task_id);
  f.runner.seal(predispatch, "cancelled", "queued cancellation", "queued_cancellation");
  const afterCancel = await f.launch({ ...input, key: "after-cancel" }, { "--continue-from": next.task_id });
  assert.equal(afterCancel.error, undefined, JSON.stringify(afterCancel));
  assert.equal(f.runner.load(afterCancel.task_id).continuationHandle.backendSessionId, 'fixture-session');
});

test("missing launch metadata and unknown terminal do not authorize continuation", async (t) => {
  const f = fixture(t);
  const next = { schema_version: 1, key: "next", prompt: "next", callback: f.input.callback };
  assert.equal((await f.launch(next, { "--continue-from": `task_${'a'.repeat(64)}` })).error.code, "LAUNCH_METADATA_REQUIRED");
  const original = await f.launch();
  const task = f.runner.load(original.task_id);
  task.state = "ambiguous"; task.notificationKind = "no_progress"; f.runner.write(task);
  assert.equal((await f.launch(next, { "--continue-from": original.task_id })).error.code, "CONTINUE_BUSY_OR_UNKNOWN");
});

test("all validation precedes Git writes; conflicts and private-file boundaries", async (t) => {
  const f = fixture(t), before = git(f.repo, "show-ref");
  for (const change of [{ branch: "../escape" }, { branch: "--option" }, { worktree: "../escape" }, { worktree: "/absolute" },
    { base_sha: f.old }, { permissions: { mode: "anything" } }, { prompt: f.input.callback.callback_id },
    { no_progress_timeout_seconds: 0 }, { no_progress_timeout_seconds: 86401 }, { no_progress_timeout_seconds: "900" },
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
  assert.equal((await f.launch()).error.code, "GIT_PREPARATION_INTERRUPTED");
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
  assert.equal(result.task_recorded, false); assert.equal(result.claim_recorded, true);
  assert.equal(result.dispatch_state, "not_reached"); assert.deepEqual(result.unknown_scope, ["preparation"]);
  assert.equal(result.error.git_exit_code, 128); assert.equal(result.error.reason, "unknown");
  const status = f.runner.status(result.task_id);
  assert.equal(status.task_recorded, false); assert.equal(status.claim_recorded, true);
  assert.equal(status.dispatch_state, "not_reached"); assert.equal(status.preparation.policy, "fail_closed_on_partial_git_preparation");
  assert.equal(git(f.repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"), f.old);
});

for (const stopAt of ["fetch", "branch", "worktree_directory", "worktree", "input", "submit"]) {
  test(`partial Git preparation at ${stopAt} fails closed and preserves every existing object`, async (t) => {
    const f = fixture(t);
    const partial = await f.launch(f.input, {}, { checkpoint: (stage) => {
      if (stage === stopAt) throw new Error("synthetic interruption");
    } });
    assert.equal(partial.accepted, false);
    const snapshot = () => JSON.stringify({ refs: git(f.repo, "show-ref"), worktrees: git(f.repo, "worktree", "list", "--porcelain"),
      intent: f.saved(partial), directory: fs.existsSync(path.join(f.base, "new-work"))
        ? fs.readdirSync(path.join(f.base, "new-work")) : null });
    const before = snapshot();
    const retried = await f.launch();
    assert.equal(retried.error.code, "GIT_PREPARATION_INTERRUPTED"); assert.equal(snapshot(), before);
    assert.equal(f.launches(), 0);
  });
}

test("late canonical success authorizes continuation while sealed notification remains unchanged", async (t) => {
  const f = fixture(t), original = await f.launch();
  const record = f.runner.load(original.task_id);
  record.state = "running"; record.dispatchedAt = Date.now();
  record.handle = { backend: "acpx-shared", cwd: record.cwd, sessionKey: record.sessionKey,
    acpxRecordId: "fixture-record", backendSessionId: "fixture-session" };
  f.runner.notify(record); const body = record.body;
  const next = { schema_version: 1, key: "late-next", prompt: "next", callback: f.input.callback };
  assert.equal((await f.launch(next, { "--continue-from": original.task_id })).error.code, "CONTINUE_BUSY_OR_UNKNOWN");
  f.runner.seal(record, "success", "late", "watchSession.turn_result");
  assert.equal(f.runner.load(original.task_id).body, body);
  assert.equal((await f.launch(next, { "--continue-from": original.task_id })).error, undefined);
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

test("unsupported launch metadata is preserved and never projected as private output", async (t) => {
  const f = fixture(t), original = await f.launch();
  const file = path.join(f.tasks, ".launches", `${original.task_id}.json`);
  write(file, { version: 1, key: f.input.callback.callback_id, worktree: "PRIVATE-PATH" });
  const bytes = fs.readFileSync(file), result = await f.launch();
  assert.equal(result.error.code, "UNSUPPORTED_LAUNCH_RECORD");
  assert.equal(JSON.stringify(result).includes("tcb_"), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE-PATH"), false);
  assert.deepEqual(fs.readFileSync(file), bytes);
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

test("input classification keeps callback/permissions/timeout codes and fixed field names before Git", async (t) => {
  const f = fixture(t), before = git(f.repo, "show-ref");
  for (const [change, code, field] of [
    [{ schema_version: 2 }, "INVALID_LAUNCH_INPUT", "schema_version"],
    [{ prompt: "" }, "INVALID_LAUNCH_INPUT", "prompt"],
    [{ prompt: f.input.callback.callback_id }, "CALLBACK_IN_PROMPT", "prompt"],
    [{ callback: { ...f.input.callback, callback_id: "PRIVATE-BAD-BEARER" } }, "INVALID_CALLBACK", "callback.callback_id"],
    [{ callback: { ...f.input.callback, callback_url: "https://user:PRIVATE-URL@callback.invalid/api/agents/task-callbacks" } }, "INVALID_CALLBACK", "callback.callback_url"],
    [{ callback: { ...f.input.callback, callback_url: "PRIVATE-MALFORMED-URL" } }, "INVALID_CALLBACK", "callback.callback_url"],
    [{ callback: { ...f.input.callback, max_output_bytes: 32769 } }, "INVALID_CALLBACK", "callback.max_output_bytes"],
    [{ permissions: { mode: "PRIVATE-MODE" } }, "INVALID_PERMISSIONS", "permissions.mode"],
    [{ permissions: { policy: { autoDeny: [""] } } }, "INVALID_PERMISSIONS", "permissions.policy.autoDeny"],
    [{ no_progress_timeout_seconds: "900" }, "INVALID_NO_PROGRESS_TIMEOUT", "no_progress_timeout_seconds"],
    [{ provider: 1 }, "LAUNCH_SELECTION_INVALID", "provider"],
    [{ branch: "../escape" }, "INVALID_LAUNCH_INPUT", "branch"],
    [{ worktree: "/escape" }, "INVALID_LAUNCH_INPUT", "worktree"],
    [{ "PRIVATE-UNKNOWN-FIELD": f.input.callback }, "INVALID_LAUNCH_INPUT", "fields"],
  ]) {
    const result = await f.launch({ ...f.input, ...change });
    assert.equal(result.error.code, code); assert.equal(result.error.field, field);
    assert.equal(result.error.stage, "validate"); assert.equal(result.task_recorded, false); assert.equal(result.outcome_unknown, false);
    for (const secret of ["PRIVATE-", f.input.prompt, f.input.callback.callback_id, f.input.callback.callback_url]) assert.equal(JSON.stringify(result).includes(secret), false);
  }
  fs.writeFileSync(f.inputFile, '{"PRIVATE-JSON":');
  const malformed = await launchTask(f.runner, { "--input-file": f.inputFile }, f.options);
  assert.equal(malformed.error.code, "INVALID_LAUNCH_JSON"); assert.equal(malformed.error.stage, "input"); assert.equal(malformed.error.field, "input_file");
  const missing = await launchTask(f.runner, { "--input-file": path.join(f.base, "PRIVATE-NOT-FOUND.json") }, f.options);
  assert.equal(missing.error.code, "LAUNCH_INPUT_UNREADABLE"); assert.equal(missing.error.reason, "ENOENT");
  assert.equal(JSON.stringify(missing).includes("PRIVATE-"), false);
  assert.equal(git(f.repo, "show-ref"), before); assert.equal(fs.existsSync(path.join(f.tasks, ".launches")), false); assert.equal(f.launches(), 0);
});

test("missing selection environment is named without values and an existing claim still fails closed", async (t) => {
  const f = fixture(t), before = git(f.repo, "show-ref"), key = process.env.CODEX_API_KEY;
  let result;
  delete process.env.CODEX_API_KEY;
  try { result = await f.launch(); } finally { process.env.CODEX_API_KEY = key; }
  assert.equal(result.error.code, "LAUNCH_ENVIRONMENT_INVALID"); assert.equal(result.error.field, "environment");
  assert.equal(result.error.reason, "missing"); assert.deepEqual(result.error.environment_names, ["CODEX_API_KEY"]);
  assert.equal(result.task_recorded, false); assert.equal(result.outcome_unknown, true); assert.equal(result.error.action, "inspect_preparation");
  const file = path.join(f.tasks, ".launches", `${result.task_id}.json`), bytes = fs.readFileSync(file);
  assert.equal((await f.launch()).error.code, "GIT_PREPARATION_INTERRUPTED");
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(git(f.repo, "show-ref"), before); assert.equal(f.launches(), 0);
});

test("selection process errors keep only fixed codes/fields/variable names, never stderr/cause", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.version, "runtime.py"), `import json, sys
print(json.dumps({'error': {'code': 'LAUNCH_SELECTION_INVALID', 'field': 'PRIVATE-FIELD', 'reason': 'PRIVATE-REASON',
 'environment_names': ['CODEX_API_KEY', 'PRIVATE-NAME'], 'message': 'PRIVATE-MESSAGE', 'cause': 'PRIVATE-CAUSE', 'stack': 'PRIVATE-STACK'}}))
print('PRIVATE-STDERR', file=sys.stderr)
sys.exit(1)
`);
  const result = await f.launch();
  assert.equal(result.error.code, "LAUNCH_SELECTION_INVALID"); assert.equal(result.error.field, "selection");
  assert.equal(result.error.reason, "unknown"); assert.deepEqual(result.error.environment_names, ["CODEX_API_KEY"]);
  assert.equal(JSON.stringify(result).includes("PRIVATE-"), false); assert.equal(JSON.stringify(f.saved(result)).includes("PRIVATE-"), false);
  assert.equal(f.launches(), 0);
});

test("fsync failure after task rename keeps the original request but does not claim acceptance or dispatch", async (t) => {
  const f = fixture(t), taskDir = path.join(f.tasks, `task_${digest(f.input.key)}`), sync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === taskDir && fs.existsSync(path.join(taskDir, "task.json")))
      throw Object.assign(new Error("PRIVATE-FSYNC-CAUSE"), { code: "ENOSPC" });
    return sync(fd);
  });
  const failed = await f.launch();
  assert.equal(failed.error.code, "TASK_WRITE_FAILED"); assert.equal(failed.error.stage, "submit"); assert.equal(failed.error.field, "task_record");
  assert.equal(failed.error.reason, "ENOSPC"); assert.equal(failed.accepted, false); assert.equal(failed.task_recorded, null); assert.equal(failed.outcome_unknown, true);
  assert.ok(failed.request_id); assert.equal(f.launches(), 0);
  assert.equal(f.runner.load(failed.task_id).dispatchedAt, undefined); assert.equal(JSON.stringify(failed).includes("PRIVATE-"), false);
  t.mock.restoreAll();
  f.runner.submit = () => assert.fail("must not resubmit");
  const retry = await f.launch(f.input, {}, { spawnControl: (id, reused) => { assert.equal(reused, true); return f.runner.execute(id, { observeOnly: true }); } });
  assert.equal(retry.request_id, failed.request_id); assert.equal(f.runner.status(failed.task_id).execution_error, "RECOVERED_BEFORE_DISPATCH");
});

test("first claim parent fsync failure is storage uncertainty before any Git or submit", async (t) => {
  const f = fixture(t), sync = fs.fsyncSync, before = git(f.repo, "show-ref");
  t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.tasks) throw Object.assign(new Error("PRIVATE-FSYNC"), { code: "EIO" });
    return sync(fd);
  });
  const failed = await f.launch(); t.mock.restoreAll();
  assert.equal(failed.error.code, "TASK_WRITE_FAILED"); assert.equal(failed.claim_recorded, null);
  assert.equal(failed.task_recorded, false); assert.equal(failed.dispatch_state, "not_reached");
  assert.deepEqual(failed.unknown_scope, ["preparation", "storage"]); assert.equal(f.launches(), 0);
  assert.equal(git(f.repo, "show-ref"), before);
  assert.equal((await f.launch()).error.code, "GIT_PREPARATION_INTERRUPTED");
});

test("lost control ACK is unknown with a durable request, not invalid input or permission to resend", async (t) => {
  const f = fixture(t);
  const failed = await f.launch(f.input, {}, { spawnControl: async () => { throw new TaskError("CONTROL_ACK_UNKNOWN", { reason: "timeout" }); } });
  assert.equal(failed.error.code, "CONTROL_ACK_UNKNOWN"); assert.equal(failed.error.stage, "control"); assert.equal(failed.error.field, "control_ack");
  assert.equal(failed.error.reason, "timeout"); assert.equal(failed.task_recorded, true); assert.equal(failed.outcome_unknown, true);
  assert.equal(failed.claim_recorded, true); assert.equal(failed.dispatch_state, "unknown"); assert.deepEqual(failed.unknown_scope, ["request"]);
  assert.equal(failed.error.request_id, failed.request_id); assert.equal(failed.error.action, "observe_original");
  f.runner.submit = () => assert.fail("must not resubmit");
  assert.equal((await f.launch()).request_id, failed.request_id);
});

test("last claim fsync fails after ACK: accepted remains true; task/request must never be resubmitted", async (t) => {
  const f = fixture(t);
  const failed = await f.launch(f.input, {}, { spawnControl: async () => {
    t.mock.method(fs, "fsyncSync", () => { throw Object.assign(new Error("PRIVATE-FSYNC"), { code: "EIO" }); });
  } });
  t.mock.restoreAll();
  assert.equal(failed.error.code, "TASK_WRITE_FAILED"); assert.equal(failed.error.field, "launch_record");
  assert.equal(failed.accepted, true); assert.equal(failed.task_recorded, true); assert.equal(failed.claim_recorded, null);
  assert.ok(failed.unknown_scope.includes("storage")); assert.ok(failed.request_id); assert.equal(failed.dispatch_state, "unknown");
  f.runner.submit = () => assert.fail("must not resubmit");
  const again = await f.launch(); assert.equal(again.request_id, failed.request_id);
  assert.equal(again.no_progress_timeout_seconds, 900); assert.equal(again.continue_from, null);
  assert.equal(again.query.status, `'${f.root}/bin/opencode-task' status ${again.task_id}`); assert.equal(again.session_id, null); assert.equal(again.started_at, null);
});

test("exclusive same-key claim permits one submit while concurrent preparation fails closed", async (t) => {
  const f = fixture(t), submit = f.runner.submit.bind(f.runner); let submissions = 0;
  f.runner.submit = (input) => { submissions++; return submit(input); };
  const results = await Promise.all([f.launch(), f.launch()]);
  assert.equal(submissions, 1); assert.equal(results.filter((value) => value.accepted).length, 1);
  const rejected = results.find((value) => value.error);
  assert.equal(rejected.error.code, "GIT_PREPARATION_INTERRUPTED");
  assert.equal(rejected.dispatch_state, "not_reached");
  const retry = await f.launch(); assert.equal(retry.reused, true); assert.equal(submissions, 1);
});

test("continue inherits smaller saved permissions, rules expose only fixed safe names", async (t) => {
  const f = fixture(t), original = await f.launch({ ...f.input, permissions: { mode: "deny-all", policy: { autoDeny: ["edit", "PRIVATE-RULE"] } } });
  const task = f.runner.load(original.task_id);
  task.handle = { backend: "acpx-shared", cwd: task.cwd, sessionKey: task.sessionKey, acpxRecordId: "fixture-record", backendSessionId: "fixture-session" };
  f.runner.seal(task, "success", "done", "turn.result");
  const next = await f.launch({ schema_version: 1, key: "inherit", prompt: "next", callback: f.input.callback }, { "--continue-from": original.task_id });
  assert.equal(next.permissions.mode, "deny-all"); assert.deepEqual(next.permissions.auto_deny, ["edit"]); assert.equal(next.permissions.rules_withheld, 1);
  assert.equal(next.continue_from, original.task_id); assert.equal(JSON.stringify(next).includes("PRIVATE-RULE"), false);
  assert.equal(f.runner.load(original.task_id).permissions.mode, "deny-all");
});

test("claim-only status is read only, rejects corrupt association and JSON without leaking private fields", async (t) => {
  const f = fixture(t), failed = await f.launch(f.input, {}, { checkpoint: (stage) => { if (stage === "fetch") throw new Error("stop"); } });
  const file = path.join(f.tasks, ".launches", `${failed.task_id}.json`), before = fs.readFileSync(file);
  const status = f.runner.status(failed.task_id);
  assert.equal(status.state, "preparation"); assert.equal(status.task_recorded, false); assert.equal(status.dispatch_state, "not_reached");
  assert.equal(status.preparation.objects.branch, false); assert.equal(status.preparation.objects.worktree_directory, false);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.existsSync(path.join(f.tasks, failed.task_id)), false);
  const record = JSON.parse(before); record.id = `task_${"e".repeat(64)}`; write(file, record);
  assert.throws(() => f.runner.status(failed.task_id), /INVALID_TASK_RESULT/);
  fs.writeFileSync(file, '{"PRIVATE-JSON":');
  assert.throws(() => f.runner.status(failed.task_id), /INVALID_TASK_RESULT/);
});

test("Git diagnostics retain errno, exit and signal, discard bounded stderr and never infer auth from 128", async (t) => {
  const f = fixture(t), dir = path.join(f.base, "fake-bin"), previous = process.env.PATH;
  fs.mkdirSync(dir); const script = path.join(dir, "git");
  try {
    process.env.PATH = dir;
    await assert.rejects(launchGit(f.repo, []), (error) => error.git_errno === "ENOENT" && !JSON.stringify(error).includes(f.repo));
    for (const [body, reason, status, signal] of [
      ["echo PRIVATE-URL-USER-SECRET >&2; exit 128", "unknown", 128],
      ["echo 'Host key verification failed.' >&2; echo PRIVATE-KEY >&2; exit 128", "SSH_HOST_KEY_VERIFICATION_FAILED", 128],
      ["echo 'Permission denied (publickey) PRIVATE-USER' >&2; exit 128", "unknown", 128],
      ["kill -TERM $$", "unknown", undefined, "SIGTERM"],
      ["i=0; while [ $i -lt 20000 ]; do printf x >&2; i=$((i+1)); done; echo; echo 'Host key verification failed.' >&2; exit 128", "unknown", 128],
    ]) {
      fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      await assert.rejects(launchGit(f.repo, []), (error) => {
        assert.equal(error.reason, reason); assert.equal(error.git_exit_code, status); assert.equal(error.git_signal, signal);
        assert.equal(JSON.stringify(error).includes("PRIVATE-"), false); assert.equal(error.cause, undefined); return true;
      });
    }
  } finally { process.env.PATH = previous; }
});

test("reused error response does not expand untrusted launch metadata strings", async (t) => {
  const f = fixture(t), original = await f.launch(), record = f.saved(original);
  record.repo_path = "PRIVATE-REPO"; record.worktree = f.input.callback.callback_url; record.selection.model.id = "PRIVATE-MODEL";
  write(path.join(f.tasks, ".launches", `${original.task_id}.json`), record);
  const bytes = fs.readFileSync(path.join(f.tasks, ".launches", `${original.task_id}.json`));
  const result = await f.launch(f.input, {}, { spawnControl: async () => { throw new Error("PTC_TOOL_FAILED 502 EAGAIN PRIVATE-STDERR"); } });
  assert.equal(result.error.code, "INVALID_TASK_RESULT"); assert.equal(result.error.reason, "unknown");
  assert.equal(result.outcome_unknown, true); assert.equal(result.task_recorded, null);
  for (const secret of ["PRIVATE-", f.input.callback.callback_url]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(fs.readFileSync(path.join(f.tasks, ".launches", `${original.task_id}.json`)), bytes);
});

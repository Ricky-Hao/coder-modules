/** 校验、排他领取 key/后继、Git 准备；worker 接管后父进程不再写 task。 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { hash, inputHash, privateInput, permissions, callback, noProgressTimeout, save, syncDirectory, TaskError, diagnostic } from "./task.mjs";

const fail = (field, code = "INVALID_LAUNCH_INPUT", stage = "validate") => { throw new TaskError(code, { stage, field, action: stage === "validate" ? "fix_input" : "inspect_original" }); };
const branchName = (name) => typeof name === "string" && name.length <= 240 && name !== "HEAD" && !name.includes("..") && name.split("/").every((part) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".") && !part.endsWith(".lock"));
export function validateInput(filename, from) {
  const input = privateInput(filename), required = ["schema_version", "key", "prompt", "callback", ...from ? [] : ["repo_path", "branch", "worktree"]];
  const fields = [...required, ...from ? [] : ["base"], "permissions", "provider", "model", "variant", "no_progress_timeout_seconds"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((name) => !fields.includes(name))) fail("fields");
  for (const name of required) if (input[name] === undefined) fail(name);
  if (input.schema_version !== 1 || typeof input.key !== "string" || !input.key || input.key.length > 256 || /[\x00-\x1f\x7f]|tcb_|:\/\//.test(input.key)) fail("key");
  if (typeof input.prompt !== "string" || !input.prompt || Buffer.byteLength(input.prompt) > 1048576) fail("prompt");
  const target = callback(input.callback), timeout = noProgressTimeout(input.no_progress_timeout_seconds);
  for (const [name, value] of Object.entries(input)) {
    if (name === "callback") continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (/tcb_/.test(text) || text.includes(target.url) || text.includes(input.callback.callback_url)) fail(name);
  }
  let selected;
  if (input.permissions !== undefined) {
    const p = input.permissions;
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((key) => !["mode", "policy"].includes(key))) fail("permissions");
    selected = permissions(p.mode, p.policy);
  }
  for (const name of ["provider", "model", "variant"]) {
    if (input[name] !== undefined && (typeof input[name] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/.test(input[name]))) fail(name);
  }
  if (!from) {
    if (!path.isAbsolute(input.repo_path) || path.normalize(input.repo_path) !== input.repo_path) fail("repo_path");
    if (!branchName(input.branch) || input.base !== undefined && !branchName(input.base)) fail("branch");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.worktree)) fail("worktree");
  }
  return { input, target, timeout, selected };
}
export function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX", "GIT_SHALLOW_FILE",
  ].includes(name)));
}
export async function git(repo, args, stage, field) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { env: gitEnvironment(), maxBuffer: 1048576, timeout: 60000 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim());
      const reason = /(?:^|\n)OPENCODE_GIT_SSH_OPTIONS_UNSUPPORTED(?:\n|$)/.test(stderr) ? "SSH_OPTIONS_UNSUPPORTED" : error.code;
      reject(new TaskError("GIT_FAILED", { stage, field, reason })); // remote/stderr 从不进入 task 或回执。
    });
  });
}
async function selection(version, input, prior) {
  const request = { ...(prior ? { saved: Object.fromEntries(["model", "modelConfig", "modelProfile"].map((key) => [key, prior[key]])) } : {}),
    ...Object.fromEntries(["provider", "model", "variant"].filter((name) => input[name] !== undefined).map((name) => [name, input[name]])) };
  const result = await new Promise((resolve, reject) => {
    const child = execFile("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", "_selection"], { timeout: 30000, maxBuffer: 65536 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { /* 固定错误，不转发配置或子进程 stderr。 */ }
      if (error || !value || value.error) {
        const field = ["model", "variant", "provider", "environment", "model_config"].includes(value?.error?.field) ? value.error.field : "selection";
        reject(new TaskError("SELECTION_FAILED", { stage: "selection", field, reason: value?.error?.reason }));
      } else resolve(value);
    });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(request));
  });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./:-]+$/.test(result.model?.id ?? "") || !path.isAbsolute(result.modelConfig ?? "") ||
      !["env", "external"].includes(result.modelProfile)) fail("selection", "SELECTION_FAILED", "selection");
  if (prior && JSON.stringify(prior.model) !== JSON.stringify(result.model)) fail("model", "SESSION_MODEL_CONFLICT");
  return result;
}
async function prepare(store, task) {
  const { repo, branch, base, worktree } = task.git;
  const step = async (name, args, cwd = repo) => {
    task.step = name; store.write(task); return git(cwd, args, "prepare", name);
  };
  if (await step("repository", ["rev-parse", "--show-toplevel"]) !== repo) fail("repo_path", "GIT_REPOSITORY_INVALID", "prepare");
  await step("origin", ["config", "--get", "remote.origin.url"]);
  if (fs.existsSync(worktree)) fail("worktree", "GIT_OBJECT_CONFLICT", "prepare");
  const ref = `refs/opencode-launch/${task.id}`;
  await step("fetch", ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `refs/heads/${base}:${ref}`]);
  task.git.baseSha = await step("base_sha", ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(task.git.baseSha)) fail("base", "GIT_FAILED", "prepare");
  // git branch 与 mkdir 自身排他；冲突保留原对象，不覆写。
  await step("branch", ["branch", "--", branch, task.git.baseSha]);
  task.step = "worktree_directory"; store.write(task); fs.mkdirSync(worktree, { mode: 0o700 });
  await step("worktree", ["worktree", "add", "--", worktree, branch]);
  task.cwd = worktree;
}
export async function launchTask(store, flags, { version, spawnControl }) {
  let task, key, id, recorded = false, controlAttempted = false, reused = false;
  try {
    const filename = flags["--input-file"], from = flags["--continue-from"];
    if (!filename) fail("input_file");
    const { input, target, timeout, selected } = validateInput(filename, from);
    key = input.key; id = `task_${hash(key)}`;
    const fingerprint = inputHash(input, from), dirname = path.dirname(store.filename(id));
    const reuse = () => {
      reused = true;
      try { task = store.load(id); } catch (error) { if (error.code === "TASK_NOT_FOUND") fail("key", "PREPARATION_INCOMPLETE", "prepare"); throw error; }
      recorded = true;
      if (task.inputHash !== fingerprint) fail("key", "LAUNCH_CONFLICT");
      if (task.phase === "preparing") fail(task.step, "PREPARATION_INCOMPLETE", "prepare");
      return { ...store.summary(task, { reused: true }), task_recorded: true };
    };
    if (fs.existsSync(dirname)) return reuse();
    let prior;
    if (from) {
      prior = store.load(from);
      if (fs.existsSync(store.filename(from, "successor.json"))) fail("continue_from", "CONTINUE_NOT_LATEST");
      if (prior.phase !== "finished" || !prior.result) fail("continue_from", "CONTINUE_BUSY_OR_UNKNOWN");
      if (!prior.handle?.backendSessionId || !prior.handle.acpxRecordId) fail("continue_from", "CONTINUE_SESSION_UNCONFIRMED");
    }
    const config = await selection(version, input, prior);
    try { fs.mkdirSync(dirname, { mode: 0o700 }); syncDirectory(store.root); }
    catch (error) { if (error.code === "EEXIST") return reuse(); throw error; }
    task = { version: 3, id, key: input.key, inputFile: filename, inputHash: fingerprint,
      phase: "preparing", step: "claimed", createdAt: store.now(), progress: store.stamp(), noProgressMs: timeout,
      requestId: randomUUID(), sessionKey: prior?.sessionKey ?? `launch-${hash(input.key)}`,
      git: prior?.git ?? { repo: input.repo_path, branch: input.branch, base: input.base ?? "main", worktree: path.join(path.dirname(input.repo_path), input.worktree) },
      ...config, permissions: selected ?? prior?.permissions ?? permissions(), outputLimit: target.max,
      ...(prior ? { continueFrom: from, cwd: prior.cwd, handle: prior.handle } : {}) };
    store.write(task); recorded = true;
    if (prior) {
      try { save(store.filename(from, "successor.json"), { task_id: id }, true); }
      catch (error) { if (error.code === "EEXIST") fail("continue_from", "CONTINUE_NOT_LATEST"); throw error; }
      if (await git(task.cwd, ["symbolic-ref", "HEAD"], "prepare", "worktree") !== `refs/heads/${task.git.branch}`) fail("worktree", "GIT_OBJECT_CONFLICT", "prepare");
    } else await prepare(store, task);
    task.phase = "ready"; delete task.step; store.write(task);
    controlAttempted = true;
    const ack = await spawnControl(id);
    // 从此不再写 task.json，也不为了 backend null 再查询。
    return { ...ack, task_recorded: true, reused: false };
  } catch (error) {
    if (controlAttempted && task) { try { task = store.load(task.id); } catch { /* 回执保留当时已知事实。 */ } }
    return { ...(task ? store.summary(task, { reused, uncertain: controlAttempted }) : { accepted: false, reused, key: key ?? null, task_id: id ?? null }),
      task_recorded: error.code === "TASK_WRITE_FAILED" ? null : recorded,
      error: diagnostic(error, "prepare", "task_record", "PREPARATION_FAILED") };
  }
}

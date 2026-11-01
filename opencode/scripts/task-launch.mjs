/** 高层派发：私有意图、Git 准备与现有 submit；调用者须持有 submit.lock。 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readJson, readError } from "./task-read.mjs";
import { save, taskPermissions, taskModel, validateCallback, noProgressTimeout } from "./task.mjs";
import { TaskError, errorCode, errorInfo } from "./task-errors.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const fail = (code, field, stage = "validate", reason = "invalid") => { throw new TaskError(code, { stage, field, reason }); };
const launchStages = new Set(["validate", "claimed", "fetch", "branch", "worktree_directory", "worktree", "input", "submit", "accepted"]);

function safePath(filename, privateParent = false, field = "repo_path") {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || /[\x00-\x1f\x7f]|tcb_/.test(filename)) fail("INVALID_LAUNCH_INPUT", field);
  let current = "/";
  for (const part of filename.split("/").slice(1)) {
    if (!part || part === "." || part === "..") fail("INVALID_LAUNCH_INPUT", field);
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail("UNSAFE_TASK_FILE");
  }
  if (privateParent) {
    const info = fs.statSync(path.dirname(filename));
    if (info.uid !== process.getuid() || info.mode & 0o077) fail("UNSAFE_TASK_DIRECTORY");
  }
  return filename;
}

const branchName = (name) => typeof name === "string" && name !== "HEAD" && name.length <= 240 &&
  !name.includes("..") && !name.includes("tcb_") && name.split("/").every((part) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".") && !part.endsWith(".lock"));

function inputShape(input, continuing) {
  const required = ["schema_version", "key", "prompt", "callback", ...continuing ? [] : ["repo_path", "branch", "worktree"]];
  const fields = [...required, ...(continuing ? [] : ["base"]), "permissions", "provider", "model", "variant", "no_progress_timeout_seconds"];
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_LAUNCH_INPUT", "fields");
  for (const name of required) if (input[name] === undefined) fail("INVALID_LAUNCH_INPUT", name, "validate", "missing");
  if (Object.keys(input).some((key) => !fields.includes(key))) fail("INVALID_LAUNCH_INPUT", continuing && input.base !== undefined ? "base" : "fields");
  if (input.schema_version !== 1) fail("INVALID_LAUNCH_INPUT", "schema_version");
  if (typeof input.key !== "string" || !input.key || input.key.length > 256 || /[\x00-\x1f\x7f]|tcb_/.test(input.key)) fail("INVALID_LAUNCH_INPUT", "key");
  if (typeof input.prompt !== "string" || !input.prompt || Buffer.byteLength(input.prompt) > 1048576) fail("INVALID_LAUNCH_INPUT", "prompt");
}

function inputPermissions(input, callback) {
  const p = input.permissions;
  if (p === undefined) return;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((key) => !["mode", "policy"].includes(key))) fail("INVALID_PERMISSIONS", "permissions");
  const text = JSON.stringify(p);
  if (/tcb_/.test(text) || [callback.callback_url, input.callback.callback_url].some((url) => text.includes(url))) fail("INVALID_PERMISSIONS", "permissions");
  taskPermissions(p.mode, p.policy);
}

function inputSelection(input) {
  const selectionPatterns = { provider: /^[A-Za-z0-9_.-]{1,128}$/, model: /^[A-Za-z0-9_./:-]{1,256}$/, variant: /^[A-Za-z0-9_.-]{1,64}$/ };
  for (const name of ["provider", "model", "variant"])
    if (input[name] !== undefined && (typeof input[name] !== "string" ||
        !selectionPatterns[name].test(input[name]) || input[name].includes("tcb_"))) fail("LAUNCH_SELECTION_INVALID", name);
}

function inputFile(filename, continuing) {
  try { safePath(filename, true, "input_file"); }
  catch (error) { throw new TaskError(errorCode(error, "LAUNCH_INPUT_UNREADABLE"), { stage: "input", field: "input_file", reason: error?.code }); }
  const input = readJson(filename, 1048576 + 16384, { stage: "input", field: "input_file", invalidCode: "INVALID_LAUNCH_JSON", readCode: "LAUNCH_INPUT_UNREADABLE" });
  inputShape(input, continuing);
  if (!input.callback || typeof input.callback !== "object" || Array.isArray(input.callback) || Buffer.byteLength(JSON.stringify(input.callback)) > 4096) fail("INVALID_CALLBACK", "callback");
  const callback = validateCallback(input.callback);
  noProgressTimeout(input.no_progress_timeout_seconds);
  if (/tcb_[A-Za-z0-9_-]{43}/.test(input.prompt)) fail("CALLBACK_IN_PROMPT", "prompt");
  for (const name of ["prompt", "key", "repo_path", "branch", "worktree", "base"]) {
    const text = input[name];
    if (typeof text === "string" && [callback.callback_id, callback.callback_url, input.callback.callback_url].some((secret) => text.includes(secret)))
      fail(name === "prompt" ? "CALLBACK_IN_PROMPT" : "INVALID_LAUNCH_INPUT", name);
  }
  inputPermissions(input, callback); inputSelection(input);
  if (!continuing) {
    try { safePath(input.repo_path); }
    catch (error) { throw new TaskError(errorCode(error, "GIT_REPOSITORY_INVALID"), { stage: "validate", field: "repo_path", reason: error?.code }); }
    if (input.base !== undefined && !branchName(input.base)) fail("INVALID_LAUNCH_INPUT", "base");
    if (!branchName(input.branch)) fail("INVALID_LAUNCH_INPUT", "branch");
    if (typeof input.worktree !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.worktree) || input.worktree.includes("tcb_")) fail("INVALID_LAUNCH_INPUT", "worktree");
  }
  return input;
}

async function git(repo, args, code = "GIT_PREPARE_FAILED", missing = false) {
  return new Promise((resolve, reject) => {
    // Git 继承同一 flock；CLI 中断后，仍在准备的 Git 退出前不能开始另一个提交者。
    const lock = process.env.OPENCODE_MODULE_LAUNCH_LOCK;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
      "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX", "GIT_SHALLOW_FILE",
    ].includes(name)));
    const child = spawn("git", ["-C", repo, ...args], { env, stdio: ["ignore", "pipe", "ignore", ...(lock ? [Number(lock)] : [])] });
    let output = "", bytes = 0;
    child.stdout.on("data", (data) => { bytes += data.length; if (bytes <= 1048576) output += data.toString("utf8"); });
    child.once("error", () => reject(new Error(code)));
    child.once("close", (status) => {
      if (missing && status === 1) resolve(null);
      else if (status !== 0 || bytes > 1048576) reject(new Error(code));
      else resolve(output.trim());
    }); // stderr/remote 可能含凭据；永不进入返回或记录。
  });
}

const identity = (filename) => {
  const info = fs.lstatSync(filename);
  if (!info.isDirectory()) fail("LAUNCH_OBJECT_CONFLICT");
  return [info.dev, info.ino];
};
const equal = (left, right) => canonical(left) === canonical(right);
const exists = (filename) => { try { fs.lstatSync(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

async function repository(repo) {
  try {
    safePath(repo); safePath(path.join(repo, ".git"));
    const top = await git(repo, ["rev-parse", "--show-toplevel"], "GIT_REPOSITORY_INVALID");
    if (top !== repo) fail("GIT_REPOSITORY_INVALID");
    const common = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "GIT_REPOSITORY_INVALID");
    safePath(common);
    const origin = await git(repo, ["config", "--get", "remote.origin.url"], "GIT_REPOSITORY_INVALID");
    if (!origin) fail("GIT_REPOSITORY_INVALID");
    return { common, identity: identity(common), originHash: hash(origin) };
  } catch (error) { throw new TaskError(errorCode(error, "GIT_REPOSITORY_INVALID"), { stage: "repository", field: "repo_path", reason: error?.code }); }
}

async function selection(version, input, prior) {
  const saved = prior?.selection;
  const request = { ...(saved ? { saved } : {}), ...Object.fromEntries(["provider", "model", "variant"]
    .filter((name) => input[name] !== undefined).map((name) => [name, input[name]])) };
  const child = await new Promise((resolve) => {
    // stdio 只传非秘密选择；不传 prompt/callback。
    const process = execFile("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", "_selection"],
      { timeout: 30000, maxBuffer: 65536 }, (error, stdout) => resolve({ error, stdout }));
    process.stdin.on("error", () => {}); // execFile 的完成结果决定分类，不记录私密 stderr。
    process.stdin.end(JSON.stringify(request));
  });
  let result;
  try { result = JSON.parse(child.stdout); } catch { fail("LAUNCH_SELECTION_INVALID", "selection", "selection", child.error?.killed ? "timeout" : "selection_process_failed"); }
  if (child.error || result?.error) {
    const detail = result?.error;
    throw new TaskError(errorCode(detail?.code, "LAUNCH_SELECTION_INVALID"), { stage: "selection", field: detail?.field ?? "selection",
      reason: detail?.reason ?? (child.error?.killed ? "timeout" : "selection_process_failed"), environment_names: detail?.environment_names });
  }
  try { taskModel(result?.model); } catch { fail("LAUNCH_SELECTION_INVALID", "model", "selection"); }
  if (!path.isAbsolute(result.modelConfig ?? "") || !["env", "external"].includes(result.modelProfile)) fail("LAUNCH_SELECTION_INVALID", "model_config", "selection");
  if (saved && !equal(saved, result)) fail("SESSION_MODEL_CONFLICT", "selection", "selection");
  return result;
}

function metadata(store, id, runner) {
  if (!/^task_[a-f0-9]{64}$/.test(id)) fail("INVALID_LAUNCH_INPUT", "continue_from");
  if (!exists(path.join(store, `${id}.json`))) fail("LAUNCH_METADATA_REQUIRED");
  const record = readJson(path.join(store, `${id}.json`), undefined, { field: "launch_record" });
  if (record.version !== 2) fail("UNSUPPORTED_LAUNCH_RECORD");
  const task = runner.load(id);
  if (record.id !== id || !equal(task.launch, proof(record)) || task.cwd !== record.worktree)
    fail("LAUNCH_METADATA_REQUIRED");
  return record;
}

function terminal(task) {
  return Boolean(task.result && ["turn.result", "watchSession.turn_result", "queued_cancellation", "execution_setup_failure"].includes(task.result.source));
}

function sessionHandle(task) {
  // 续接在 dispatch 前取消/失败时，保留上轮已经证明的 session 身份。
  return task.handle ?? (!task.dispatchedAt ? task.continuationHandle : undefined);
}

async function prepare(record, persist) {
  const repo = record.repo_path;
  if (!equal(record.repository, await repository(repo))) fail("LAUNCH_OBJECT_CONFLICT");
  if (exists(record.worktree) || await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`], undefined, true))
    fail("LAUNCH_OBJECT_CONFLICT");
  record.stage = "fetch"; persist();
  // 隔离其他终端的 FETCH_HEAD；此 ref 仅保存本次 fetch 结果，不用于中断恢复。
  const fetched = `refs/opencode-launch/${record.token}`;
  await git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `refs/heads/${record.base}:${fetched}`], "GIT_FETCH_FAILED");
  record.base_sha = await git(repo, ["rev-parse", "--verify", `${fetched}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(record.base_sha)) fail("GIT_PREPARE_FAILED");
  record.stage = "branch"; persist();
  await git(repo, ["branch", "--", record.branch, record.base_sha]);
  record.stage = "worktree_directory"; persist();
  fs.mkdirSync(record.worktree, { mode: 0o700 }); // 排他创建；不采用碰巧为空的未知目录。
  record.worktreeIdentity = identity(record.worktree);
  record.stage = "worktree"; persist();
  await git(repo, ["worktree", "add", "--", record.worktree, record.branch]);
  await verifyWorktree(record);
  if (await git(record.worktree, ["status", "--porcelain"])) fail("LAUNCH_OBJECT_CONFLICT");
  record.stage = "input"; persist();
}

async function verifyWorktree(record) {
  safePath(record.worktree);
  safePath(path.join(record.worktree, ".git"));
  if (!equal(identity(record.worktree), record.worktreeIdentity) ||
      await git(record.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== record.repository.common ||
      await git(record.worktree, ["symbolic-ref", "HEAD"]) !== `refs/heads/${record.branch}`) fail("LAUNCH_OBJECT_CONFLICT");
}

function response(record, task, reused) {
  const model = record?.selection?.model;
  return { version: 1, key: record?.key ?? null, task_id: record?.id ?? null, request_id: task?.requestId ?? null,
    accepted: Boolean(task && record?.controlAck), stage: record?.stage === undefined ? "validate" : launchStages.has(record.stage) ? record.stage : "unknown", reused,
    repo_path: record?.repo_path ?? null, branch: record?.branch ?? null, worktree: record?.worktree ?? null,
    base: record?.base ?? (record?.version === 2 ? "main" : null), base_sha: record?.base_sha ?? null,
    session: record?.session ?? null, session_id: task?.handle?.backendSessionId ?? null,
    selection: model ? { provider: model.id.split("/")[0], model: model.id.split("/").slice(1).join("/"), variant: model.variant ?? null,
      status: "resolved" } : null,
    permissions: record?.permissions ? { mode: record.permissions.mode, policy_rules: Object.values(record.permissions.policy).filter(Array.isArray).reduce((n, rules) => n + rules.length, 0),
       default_action: record.permissions.policy.defaultAction ?? null } : null };
}

const proof = (record) => ({ token: record.token, inputHash: record.inputHash, origin: record.origin });

function originalTask(runner, record) {
  const task = runner.load(record.id);
  if (!equal(task.launch, proof(record))) fail("SUBMIT_CONFLICT");
  return task;
}

export async function launchTask(runner, flags, { version, spawnControl, checkpoint = () => {} }) {
  let record, task, input, reused = false, filename, trustedRecord = false, stage = "input", field = "input_file";
  const persist = () => { save(filename, record, { stage: record.stage === "accepted" ? "control" : record.stage, field: "launch_record" }); checkpoint(record.stage); };
  try {
    if (!flags["--input-file"]) fail("INVALID_LAUNCH_INPUT", "input_file", "input", "missing");
    input = inputFile(flags["--input-file"], Boolean(flags["--continue-from"]));
    stage = "validate"; field = "launch_record";
    const inputHash = hash(canonical({ input, continueFrom: flags["--continue-from"] ?? null }));
    const id = `task_${hash(input.key)}`, store = path.join(runner.root, ".launches");
    record = { key: input.key, id, stage: "validate" };
    if (!exists(store)) {
      fs.mkdirSync(store, { mode: 0o700 });
      const fd = fs.openSync(runner.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    const info = fs.lstatSync(store);
    if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) fail("UNSAFE_TASK_DIRECTORY");
    filename = path.join(store, `${id}.json`);
    if (exists(filename)) {
      reused = true;
      const saved = readJson(filename, undefined, { field: "launch_record" });
      if (saved.version !== 2) fail("UNSUPPORTED_LAUNCH_RECORD");
      if (saved.id !== id || saved.key !== input.key || saved.inputHash !== inputHash) fail("LAUNCH_CONFLICT");
      record = saved;
    } else {
      if (exists(path.join(runner.root, id))) fail("SUBMIT_CONFLICT");
      const prior = flags["--continue-from"] ? metadata(store, flags["--continue-from"], runner) : undefined;
      if (prior) {
        const origin = readJson(path.join(store, `${prior.origin}.json`));
        if (origin.tail !== prior.id) fail("CONTINUE_NOT_LATEST", "continue_from");
        if (!terminal(runner.load(prior.id))) fail("CONTINUE_BUSY_OR_UNKNOWN", "continue_from");
        if (!sessionHandle(runner.load(prior.id))?.backendSessionId) fail("CONTINUE_SESSION_UNCONFIRMED", "continue_from");
      }
      const repo = prior?.repo_path ?? input.repo_path;
      stage = "repository"; field = "repo_path";
      const repoIdentity = await repository(repo);
      const worktree = prior?.worktree ?? path.join(path.dirname(repo), input.worktree);
      if (prior && !equal(prior.repository, repoIdentity)) fail("LAUNCH_OBJECT_CONFLICT");
      record = { version: 2, id, key: input.key, inputHash, token: randomUUID(), stage: "claimed",
        repo_path: repo, repository: repoIdentity, branch: prior?.branch ?? input.branch, worktree,
        base: prior?.base ?? input.base ?? "main",
        session: prior?.session ?? `launch-${hash(input.key)}`, origin: prior?.origin ?? id, tail: id,
        permissions: input.permissions ? taskPermissions(input.permissions.mode, input.permissions.policy) : prior?.permissions ?? taskPermissions(),
        ...(prior ? { base_sha: prior.base_sha, worktreeIdentity: prior.worktreeIdentity, prior: prior.id,
          continuationHandle: sessionHandle(runner.load(prior.id)) } : {}) };
      trustedRecord = true;
      persist(); // key 在 profile/Git 写入前领取。
    }
    stage = "read"; field = "task_record";
    if (exists(path.join(runner.root, id, "task.json"))) { task = originalTask(runner, record); trustedRecord = true; }
    if (!task) {
      // 任何中断都保留现场；同 key 只可复用已经持久提交的原 request。
      if (reused) fail("GIT_PREPARATION_INTERRUPTED", "launch_record", launchStages.has(record.stage) ? record.stage : "unknown", "unknown");
      stage = "selection"; field = "selection";
      record.selection = await selection(version, input, record.prior ? readJson(path.join(store, `${record.prior}.json`)) : undefined);
      persist();
      runner.bindSession({ cwd: record.worktree, session: record.session, ...record.selection });
      if (record.origin !== record.id) {
        const originFile = path.join(store, `${record.origin}.json`), origin = readJson(originFile);
        if (origin.tail !== record.id && origin.tail !== record.prior) fail("CONTINUE_NOT_LATEST");
        origin.tail = record.id; save(originFile, origin, { stage: "selection", field: "launch_record" });
      }
      if (record.prior) {
        await verifyWorktree(record);
        record.stage = "input"; persist();
      } else { stage = "worktree"; field = "worktree"; await prepare(record, persist); }
      record.stage = "submit"; persist();
      stage = "submit"; field = "task_record";
      try {
        await runner.submit({ key: input.key, prompt: input.prompt, callback: input.callback,
          cwd: record.worktree, session: record.session, permissionMode: record.permissions.mode, permissionPolicy: record.permissions.policy,
          ...record.selection, launch: proof(record), continuationHandle: record.continuationHandle,
          noProgressMs: noProgressTimeout(input.no_progress_timeout_seconds) });
      } catch (error) {
        try { task = originalTask(runner, record); } catch { throw error; }
        // 可读记录不能证明失败的 fsync 已完成；保留关联，但不启动控制或伪造持久接受。
        if (errorCode(error, null) === "TASK_WRITE_FAILED") throw error;
      }
      task ??= originalTask(runner, record);
    }
    if (!task.result || task.callbackState === "outbox") {
      stage = "control"; field = "control_ack";
      try { await spawnControl(id, reused); }
      catch (error) { throw new TaskError(errorCode(error, "CONTROL_ACK_UNKNOWN"), { ...(error instanceof TaskError ? error : {}), stage, field }); }
    }
    record.controlAck = true; record.stage = "accepted"; persist();
    return response(record, task, reused);
  } catch (error) {
    if (record?.stage === "submit" && !task) {
      try { task = originalTask(runner, record); } catch { /* 部分提交不能确认时明确报告 unknown。 */ }
    }
    const code = errorCode(error, stage === "read" ? readError(error) : stage === "input" ? "LAUNCH_INPUT_UNREADABLE" : "TASK_OPERATION_FAILED");
    const info = errorInfo(code, { ...(error instanceof TaskError ? error : { stage, field, reason: error?.code }) });
    if (info.stage === "unknown") info.stage = stage;
    if (info.field === "unknown") info.field = field;
    if (["GIT_FETCH_FAILED", "GIT_PREPARE_FAILED"].includes(code)) { info.stage = record.stage; info.field = record.stage === "fetch" ? "base" : record.stage === "branch" ? "branch" : "worktree"; }
    if (!(error instanceof TaskError) && stage === "worktree") info.stage = record.stage;
    const taskRecorded = code === "TASK_WRITE_FAILED" && info.stage === "submit" ? null : task ? true : reused || record?.stage === "submit" ? null : false;
    if (taskRecorded !== false) info.hint += " task 关联可能已持久接受；先查原 task，必要时仅显式 recover 原 request/原 body。";
    else if (record && record.stage !== "validate") {
      info.action = "inspect_preparation"; info.hint += " 本 key 的 claim 可能已保存；修正字段也不授权自动续完。保留原输入和 Git 现场，人工核对。";
    }
    // 错误输出不展开复用/续接元数据；关联校验不证明其中任意字符串可公开。
    const projected = trustedRecord && !reused && !record.prior ? record : record && { id: record.id, key: input?.key, stage: record.stage };
    return { ...response(projected, task, reused), task_recorded: taskRecorded,
      outcome_unknown: Boolean(reused || code === "CONTROL_ACK_UNKNOWN" || code === "TASK_WRITE_FAILED" || task && !record?.controlAck || record && !task && record.stage !== "validate"),
      error: { ...errorInfo(code, { ...info, task_id: record?.id, request_id: task?.requestId }), hint: info.hint } };
  }
}

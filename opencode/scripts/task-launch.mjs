/** 高层派发：私有意图、Git 准备与现有 submit；调用者须持有 submit.lock。 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { readJson, readError } from "./task-read.mjs";
import { save, taskPermissions, validateCallback, deliveryState } from "./task.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const fail = (code) => { throw new Error(code); };
const codes = new Set(["INVALID_LAUNCH_INPUT", "LAUNCH_CONFLICT", "LAUNCH_SELECTION_INVALID", "SESSION_MODEL_CONFLICT",
  "LAUNCH_METADATA_REQUIRED", "CONTINUE_BUSY_OR_UNKNOWN", "CONTINUE_NOT_LATEST", "LAUNCH_OBJECT_CONFLICT",
  "CONTINUE_SESSION_UNCONFIRMED",
  "GIT_REPOSITORY_INVALID", "GIT_FETCH_FAILED", "GIT_PREPARE_FAILED", "SUBMIT_CONFLICT", "SUPERVISOR_START_FAILED"]);

function safePath(filename, privateParent = false) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || /[\x00-\x1f\x7f]|tcb_/.test(filename)) fail("INVALID_LAUNCH_INPUT");
  let current = "/";
  for (const part of filename.split("/").slice(1)) {
    if (!part || part === "." || part === "..") fail("INVALID_LAUNCH_INPUT");
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail("UNSAFE_TASK_FILE");
  }
  if (privateParent) {
    const info = fs.statSync(path.dirname(filename));
    if (info.uid !== process.getuid() || info.mode & 0o077) fail("UNSAFE_TASK_DIRECTORY");
  }
  return filename;
}

function inputFile(filename, continuing) {
  safePath(filename, true);
  const input = readJson(filename, 1048576 + 16384);
  const required = ["schema_version", "key", "prompt", "callback", ...continuing ? [] : ["repo_path", "branch", "worktree"]];
  const fields = [...required, "permissions", "provider", "model", "variant"];
  if (!input || Array.isArray(input) || required.some((key) => input[key] === undefined) ||
      Object.keys(input).some((key) => !fields.includes(key)) || input.schema_version !== 1 ||
      typeof input.key !== "string" || !input.key || input.key.length > 256 || /[\x00-\x1f\x7f]|tcb_/.test(input.key) ||
      typeof input.prompt !== "string" || !input.prompt || Buffer.byteLength(input.prompt) > 1048576 ||
      /tcb_[A-Za-z0-9_-]{43}/.test(input.prompt) ||
      !input.callback || Array.isArray(input.callback) || Buffer.byteLength(JSON.stringify(input.callback)) > 4096)
    fail("INVALID_LAUNCH_INPUT");
  let callback;
  try { callback = validateCallback(input.callback); } catch { fail("INVALID_LAUNCH_INPUT"); }
  for (const text of [input.prompt, input.key, input.repo_path ?? "", input.branch ?? "", input.worktree ?? ""])
    if (text.includes(callback.callback_id) || text.includes(callback.callback_url) || text.includes(input.callback.callback_url)) fail("INVALID_LAUNCH_INPUT");
  if (input.permissions !== undefined) {
    const p = input.permissions;
    if (!p || Array.isArray(p) || Object.keys(p).some((key) => !["mode", "policy"].includes(key))) fail("INVALID_LAUNCH_INPUT");
    if (/tcb_/.test(JSON.stringify(p)) || [callback.callback_url, input.callback.callback_url].some((url) => JSON.stringify(p).includes(url))) fail("INVALID_LAUNCH_INPUT");
    try { taskPermissions(p.mode, p.policy); } catch { fail("INVALID_LAUNCH_INPUT"); }
  }
  const selectionPatterns = { provider: /^[A-Za-z0-9_.-]{1,128}$/, model: /^[A-Za-z0-9_./:-]{1,256}$/, variant: /^[A-Za-z0-9_.-]{1,64}$/ };
  for (const name of ["provider", "model", "variant"])
    if (input[name] !== undefined && (typeof input[name] !== "string" ||
        !selectionPatterns[name].test(input[name]) || input[name].includes("tcb_"))) fail("INVALID_LAUNCH_INPUT");
  if (!continuing) {
    safePath(input.repo_path);
    if (typeof input.branch !== "string" || input.branch === "HEAD" || input.branch.length > 240 || input.branch.includes("..") || input.branch.includes("tcb_") ||
        !input.branch.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".") && !part.endsWith(".lock")) ||
        typeof input.worktree !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.worktree) || input.worktree.includes("tcb_")) fail("INVALID_LAUNCH_INPUT");
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
  safePath(repo);
  safePath(path.join(repo, ".git"));
  const top = await git(repo, ["rev-parse", "--show-toplevel"], "GIT_REPOSITORY_INVALID");
  if (top !== repo) fail("GIT_REPOSITORY_INVALID");
  const common = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "GIT_REPOSITORY_INVALID");
  safePath(common);
  const origin = await git(repo, ["config", "--get", "remote.origin.url"], "GIT_REPOSITORY_INVALID");
  if (!origin) fail("GIT_REPOSITORY_INVALID");
  return { common, identity: identity(common), originHash: hash(origin) };
}

async function selection(version, input, prior) {
  const saved = prior?.selection;
  const request = { ...(saved ? { saved } : {}), ...Object.fromEntries(["provider", "model", "variant"]
    .filter((name) => input[name] !== undefined).map((name) => [name, input[name]])) };
  const child = await new Promise((resolve, reject) => {
    // stdio 只传非秘密选择；不传 prompt/callback。
    const process = execFile("python3", ["-B", path.join(version, "runtime.py"), "opencode-task", "_selection"],
      { timeout: 30000, maxBuffer: 65536 }, (error, stdout) => error ? reject(new Error("LAUNCH_SELECTION_INVALID")) : resolve(stdout));
    process.stdin.end(JSON.stringify(request));
  });
  let result;
  try { result = JSON.parse(child); if (!result.model) throw 0; } catch { fail("LAUNCH_SELECTION_INVALID"); }
  if (saved && !equal(saved, result)) fail("SESSION_MODEL_CONFLICT");
  return result;
}

function metadata(store, id, runner) {
  if (!/^task_[a-f0-9]{64}$/.test(id)) fail("INVALID_LAUNCH_INPUT");
  if (!exists(path.join(store, `${id}.json`))) fail("LAUNCH_METADATA_REQUIRED");
  const record = readJson(path.join(store, `${id}.json`));
  const task = runner.load(id);
  if (record.id !== id || !equal(task.launch, proof(record)) || task.cwd !== record.worktree)
    fail("LAUNCH_METADATA_REQUIRED");
  return record;
}

function terminal(task) {
  return Boolean(task.resultStatus && ["turn.result", "watchSession.turn_result", "queued_cancellation", "execution_setup_failure"].includes(task.terminalSource));
}

function sessionHandle(task) {
  // 续接在 dispatch 前取消/失败时，保留上轮已经证明的 session 身份。
  return task.handle ?? (!task.dispatchedAt ? task.continuationHandle : undefined);
}

async function prepare(record, persist, timed) {
  const repo = record.repo_path, branch = `refs/heads/${record.branch}`;
  if (!equal(record.repository, await repository(repo))) fail("LAUNCH_OBJECT_CONFLICT");
  if (!record.base_sha) {
    record.stage = "fetch"; persist();
    let base = await git(repo, ["rev-parse", "--verify", "--quiet", record.fetchRef], undefined, true);
    if (!base) {
      await timed("fetch", () => git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `refs/heads/main:${record.fetchRef}`], "GIT_FETCH_FAILED"));
      base = await git(repo, ["rev-parse", "--verify", `${record.fetchRef}^{commit}`]);
    }
    if (!/^[a-f0-9]{40}$/.test(base)) fail("GIT_PREPARE_FAILED");
    record.base_sha = base; persist();
  }
  const current = await git(repo, ["rev-parse", "--verify", "--quiet", branch], undefined, true);
  if (current) {
    const message = await git(repo, ["reflog", "show", "--format=%gs", "-1", branch]);
    if (current !== record.base_sha || message !== `opencode-launch:${record.token}`) fail("LAUNCH_OBJECT_CONFLICT");
  } else {
    record.stage = "branch"; persist();
    await git(repo, ["update-ref", "--create-reflog", "-m", `opencode-launch:${record.token}`, branch, record.base_sha, "0".repeat(40)]);
  }
  if (!record.worktreeIdentity) {
    if (exists(record.worktree)) fail("LAUNCH_OBJECT_CONFLICT");
    record.stage = "worktree_directory"; persist();
    fs.mkdirSync(record.worktreeStaging, { mode: 0o700 });
    record.worktreeIdentity = identity(record.worktreeStaging); persist();
  }
  if (!exists(record.worktree)) {
    if (!equal(identity(record.worktreeStaging), record.worktreeIdentity)) fail("LAUNCH_OBJECT_CONFLICT");
    // Linux/glibc 原子 no-replace；并发创建的空目录也不能被 rename 覆盖。
    try { execFileSync("python3", ["-c", "import ctypes,sys; f=ctypes.CDLL(None,use_errno=True).renameat2; sys.exit(0 if f(-100,sys.argv[1].encode(),-100,sys.argv[2].encode(),1)==0 else 1)",
      record.worktreeStaging, record.worktree], { stdio: "ignore" }); } catch { fail("LAUNCH_OBJECT_CONFLICT"); }
  }
  if (!equal(identity(record.worktree), record.worktreeIdentity)) fail("LAUNCH_OBJECT_CONFLICT");
  record.stage = "worktree"; persist();
  if (!exists(path.join(record.worktree, ".git"))) {
    if (fs.readdirSync(record.worktree).length) fail("LAUNCH_OBJECT_CONFLICT");
    await timed("worktree", () => git(repo, ["worktree", "add", "--", record.worktree, record.branch]));
  }
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
    accepted: Boolean(task && record?.monitorAck), stage: record?.stage ?? "validate", reused,
    repo_path: record?.repo_path ?? null, branch: record?.branch ?? null, worktree: record?.worktree ?? null,
    base_sha: record?.base_sha ?? null, session: record?.session ?? null, session_id: task?.handle?.backendSessionId ?? null,
    selection: model ? { provider: model.id.split("/")[0], model: model.id.split("/").slice(1).join("/"), variant: model.variant ?? null,
      status: "resolved" } : null,
    permissions: record?.permissions ? { mode: record.permissions.mode, policy_rules: Object.values(record.permissions.policy).filter(Array.isArray).reduce((n, rules) => n + rules.length, 0),
      default_action: record.permissions.policy.defaultAction ?? null } : null,
    durations_ms: record?.durations ?? {} };
}

const proof = (record) => ({ token: record.token, inputHash: record.inputHash, origin: record.origin });

function originalTask(runner, record) {
  const task = runner.load(record.id);
  if (!equal(task.launch, proof(record))) fail("SUBMIT_CONFLICT");
  return task;
}

export async function launchTask(runner, flags, { version, spawnWorker, checkpoint = () => {} }) {
  let record, task, reused = false, filename;
  const persist = () => { save(filename, record); checkpoint(record.stage); };
  const timed = async (name, action) => { const start = performance.now(); try { return await action(); }
    finally { record.durations[name] = Math.round(performance.now() - start); persist(); } };
  try {
    if (!flags["--input-file"]) fail("INVALID_LAUNCH_INPUT");
    const input = inputFile(flags["--input-file"], Boolean(flags["--continue-from"]));
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
      record = readJson(filename); reused = true;
      if (record.id !== id || record.inputHash !== inputHash) fail("LAUNCH_CONFLICT");
    } else {
      if (exists(path.join(runner.root, id))) fail("SUBMIT_CONFLICT");
      const prior = flags["--continue-from"] ? metadata(store, flags["--continue-from"], runner) : undefined;
      if (prior) {
        const origin = readJson(path.join(store, `${prior.origin}.json`));
        if (origin.tail !== prior.id) fail("CONTINUE_NOT_LATEST");
        if (!terminal(runner.load(prior.id))) fail("CONTINUE_BUSY_OR_UNKNOWN");
        if (!sessionHandle(runner.load(prior.id))?.backendSessionId) fail("CONTINUE_SESSION_UNCONFIRMED");
      }
      const repo = prior?.repo_path ?? input.repo_path;
      const repoIdentity = await repository(repo);
      const worktree = prior?.worktree ?? path.join(path.dirname(repo), input.worktree);
      if (prior && !equal(prior.repository, repoIdentity)) fail("LAUNCH_OBJECT_CONFLICT");
      record = { version: 1, id, key: input.key, inputHash, token: randomUUID(), stage: "claimed", durations: {},
        repo_path: repo, repository: repoIdentity, branch: prior?.branch ?? input.branch, worktree,
        session: prior?.session ?? `launch-${hash(input.key)}`, origin: prior?.origin ?? id, tail: id,
        permissions: input.permissions ? taskPermissions(input.permissions.mode, input.permissions.policy) : prior?.permissions ?? taskPermissions(),
        ...(prior ? { base_sha: prior.base_sha, worktreeIdentity: prior.worktreeIdentity, prior: prior.id,
          continuationHandle: sessionHandle(runner.load(prior.id)) } : {}) };
      record.fetchRef = `refs/opencode-launch/${record.token}`;
      record.worktreeStaging = path.join(path.dirname(worktree), `.opencode-launch-${record.token}`);
      persist(); // key 在 profile/Git 写入前领取。
    }
    if (exists(path.join(runner.root, id, "task.json"))) task = originalTask(runner, record);
    if (!task) {
      if (record.stage === "claimed" && !record.prior && (exists(record.worktree) ||
          await git(record.repo_path, ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`], undefined, true))) fail("LAUNCH_OBJECT_CONFLICT");
      if (!record.selection) record.selection = await timed("input", () => selection(version, input,
        record.prior ? readJson(path.join(store, `${record.prior}.json`)) : undefined));
      persist();
      runner.bindSession({ cwd: record.worktree, session: record.session, ...record.selection });
      if (record.origin !== record.id) {
        const originFile = path.join(store, `${record.origin}.json`), origin = readJson(originFile);
        if (origin.tail !== record.id && origin.tail !== record.prior) fail("CONTINUE_NOT_LATEST");
        origin.tail = record.id; save(originFile, origin);
      }
      if (record.prior) {
        await verifyWorktree(record);
        record.stage = "input"; persist();
      } else await prepare(record, persist, timed);
      record.stage = "submit"; persist();
      try {
        await timed("submit", () => runner.submit({ key: input.key, prompt: input.prompt, callback: input.callback,
          cwd: record.worktree, session: record.session, permissionMode: record.permissions.mode, permissionPolicy: record.permissions.policy,
          ...record.selection, launch: proof(record), continuationHandle: record.continuationHandle }));
      } catch (error) {
        try { task = originalTask(runner, record); } catch { throw error; }
      }
      task ??= originalTask(runner, record);
    }
    if (!["delivered", "rejected"].includes(deliveryState(task))) {
      try { await spawnWorker(id); }
      catch {
        try { await spawnWorker(id, "_fail_launch"); record.monitorAck = true; } catch { /* 保留原请求给 recover。 */ }
        fail("SUPERVISOR_START_FAILED");
      }
    }
    record.monitorAck = true; record.stage = "accepted"; persist();
    return response(record, task, reused);
  } catch (error) {
    if (record?.stage === "submit" && !task) {
      try { task = originalTask(runner, record); } catch { /* 部分提交不能确认时明确报告 unknown。 */ }
    }
    const code = codes.has(error.message) ? error.message : readError(error);
    return { ...response(record, task, reused), outcome_unknown: Boolean(task && !record?.monitorAck || record && !task &&
      ["submit", "fetch", "branch", "worktree_directory", "worktree"].includes(record.stage)),
      error: { code, hint: "保留原 key、注册和输入重试；续接仅支持可信 launch 记录、原请求终态及相同选择。不要自动清理或重发 prompt。" } };
  }
}

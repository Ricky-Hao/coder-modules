/** 可信本地 store、私密输入边界和固定公开摘要。 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const taskPattern = /^task_[a-f0-9]{64}$/;
export const OUTPUT_BYTES = 32768;
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const inputHash = (input, from = null) => hash(stable({ input, from }));
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reasons = new Set(["ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC", "EDQUOT", "EROFS", "EAGAIN", "EEXIST",
  "timeout", "invalid", "process_exit", "invalid_ack", "SSH_OPTIONS_UNSUPPORTED",
  "AUTH_REQUIRED", "PERMISSION_DENIED", "PERMISSION_PROMPT_UNAVAILABLE", "QUEUE_RUNTIME_PROMPT_FAILED",
  "QUEUE_DISCONNECTED_BEFORE_ACK", "QUEUE_DISCONNECTED_BEFORE_COMPLETION", "QUEUE_SUBMISSION_OUTCOME_UNKNOWN",
  "WATCH_OUTCOME_UNKNOWN", "WATCH_CURSOR_EXPIRED", "WATCH_CURSOR_INVALID", "WATCH_CURSOR_FOREIGN", "WATCH_CURSOR_FUTURE",
  "WATCH_JOURNAL_CORRUPT", "WATCH_OWNER_UNSUPPORTED", "ACP_BACKEND_UNAVAILABLE", "ACP_SESSION_INIT_FAILED", "AGENT_DISCONNECTED"]);
export class TaskError extends Error {
  constructor(code, { stage = "read", field = "task_record", reason, action = "inspect_original" } = {}) {
    super(code);
    Object.assign(this, { code, stage, field, reason: reasons.has(reason) ? reason : "unknown", action });
  }
}
export function diagnostic(error, stage = "read", field = "task_record", code = "TASK_READ_FAILED") {
  const safe = error instanceof TaskError ? error : new TaskError(code, { stage, field, reason: error?.code });
  return { code: safe.code, stage: safe.stage, field: safe.field, reason: safe.reason, action: safe.action };
}
export function runtimeError(error, stage, field, fallback) {
  if (error instanceof TaskError) return error;
  const reason = error?.code === -32000 && error?.data?.authRequired === true ? "AUTH_REQUIRED" : error?.detailCode ?? error?.code;
  const denied = ["AUTH_REQUIRED", "PERMISSION_DENIED", "PERMISSION_PROMPT_UNAVAILABLE"].includes(reason);
  return new TaskError(denied ? reason : fallback, { stage, field, reason, action: denied ? "respect_denial" : "inspect_original" });
}
export async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TaskError("OBSERVATION_TIMEOUT", { stage: "observe", field: "request", reason: "timeout" })), ms);
  })]); } finally { clearTimeout(timer); }
}
export function readJson(filename, maximum = 2 * 1024 * 1024, optional = false) {
  try {
    if (fs.statSync(filename).size > maximum) throw new TaskError("RECORD_TOO_LARGE");
    const data = fs.readFileSync(filename);
    if (data.length > maximum) throw new TaskError("RECORD_TOO_LARGE");
    try { return JSON.parse(data); } catch { throw new TaskError("INVALID_JSON"); }
  } catch (error) {
    if (error.code === "ENOENT" && optional) return;
    throw error instanceof TaskError ? error : new TaskError(error.code === "ENOENT" ? "TASK_NOT_FOUND" : "TASK_READ_FAILED", { reason: error.code });
  }
}
export function syncDirectory(dirname) {
  try {
    const fd = fs.openSync(dirname, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) { throw new TaskError("TASK_WRITE_FAILED", { stage: "storage", reason: error.code }); }
}
export function save(filename, value, exclusive = false) {
  const temporary = path.join(path.dirname(filename), `.write-${randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (exclusive) fs.linkSync(temporary, filename);
    else fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } catch (error) {
    if (exclusive && error.code === "EEXIST") throw error;
    if (error instanceof TaskError) throw error;
    throw new TaskError("TASK_WRITE_FAILED", { stage: "storage", reason: error.code });
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function privateInput(filename) {
  try {
    if (!path.isAbsolute(filename) || path.normalize(filename) !== filename || /[\x00-\x1f\x7f]/.test(filename)) throw new Error();
    let current = "/";
    for (const part of filename.split("/").slice(1)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error();
    }
    const parent = fs.statSync(path.dirname(filename)), info = fs.lstatSync(filename);
    if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700 || !info.isFile() || info.uid !== process.getuid() ||
        info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error();
    return readJson(filename, 1048576 + 16384);
  } catch (error) { throw new TaskError("PRIVATE_INPUT_INVALID", { stage: "input", field: "input_file", reason: error?.code }); }
}
export function noProgressTimeout(seconds = 900) {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400)
    throw new TaskError("INVALID_TIMEOUT", { stage: "validate", field: "no_progress_timeout_seconds", action: "fix_input" });
  return seconds * 1000;
}
export function permissions(mode = "approve-all", policy = {}) {
  const fail = () => { throw new TaskError("INVALID_PERMISSIONS", { stage: "validate", field: "permissions", action: "fix_input" }); };
  if (!["approve-all", "approve-reads", "deny-all"].includes(mode) || !policy || typeof policy !== "object" || Array.isArray(policy)) fail();
  for (const [name, rules] of Object.entries(policy)) {
    if (name === "defaultAction") { if (!["approve", "deny", "escalate"].includes(rules)) fail(); }
    else if (!["autoApprove", "autoDeny", "escalate"].includes(name) || !Array.isArray(rules) || rules.length > 32 ||
        rules.some((rule) => typeof rule !== "string" || !rule.trim() || rule.length > 256 || /[\x00-\x1f\x7f]|tcb_/.test(rule))) fail();
  }
  return { mode, policy };
}
export function callback(input) {
  try {
    const url = new URL(input.callback_url), max = input.max_output_bytes ?? OUTPUT_BYTES;
    if (!/^tcb_[A-Za-z0-9_-]{43}$/.test(input.callback_id) || url.username || url.password || url.search || url.hash ||
        url.pathname !== "/api/agents/task-callbacks" || input.callback_url.includes(input.callback_id) ||
        !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
        !Number.isSafeInteger(max) || max < 1 || max > OUTPUT_BYTES || Buffer.byteLength(JSON.stringify(input)) > 4096) throw new Error();
    return { url: url.href, id: input.callback_id, max };
  } catch { throw new TaskError("INVALID_CALLBACK", { stage: "validate", field: "callback", action: "fix_input" }); }
}
export const bounded = (text, limit = OUTPUT_BYTES) => Buffer.from(text).subarray(0, limit).toString("utf8").replace(/\uFFFD$/, "");
export class TaskStore {
  constructor(root, { now = Date.now, tick = () => Number(process.hrtime.bigint()) / 1e6, boot } = {}) {
    this.root = root; this.now = now; this.tick = tick;
    this.boot = boot ?? hash(fs.readFileSync("/proc/sys/kernel/random/boot_id") + fs.readlinkSync("/proc/self/ns/time"));
  }
  stamp() { return { at: this.now(), tick: this.tick(), boot: this.boot }; }
  remaining(task) {
    const p = task.progress;
    return task.noProgressMs - (p.boot === this.boot && p.tick <= this.tick() ? this.tick() - p.tick : Math.max(0, this.now() - p.at));
  }
  filename(id, name = "task.json") {
    if (!taskPattern.test(id)) throw new TaskError("INVALID_TASK_ID", { field: "task_id" });
    return path.join(this.root, id, name);
  }
  load(id) {
    const task = readJson(this.filename(id));
    if (task?.version !== 3 || task.id !== id || !["preparing", "ready", "dispatched", "finished"].includes(task.phase) ||
        !task.inputFile || !task.inputHash || !task.git || !Number.isFinite(task.progress?.tick) || !Number.isSafeInteger(task.progress?.at) ||
        !Number.isSafeInteger(task.noProgressMs) || task.noProgressMs < 1 || task.noProgressMs > 86400000 || Boolean(task.result) !== (task.phase === "finished"))
      throw new TaskError("INVALID_TASK_RECORD");
    return task;
  }
  write(task) { save(this.filename(task.id), task); }
  input(task) {
    const input = privateInput(task.inputFile);
    if (inputHash(input, task.continueFrom) !== task.inputHash) throw new TaskError("INPUT_CHANGED", { stage: "input", field: "input_file" });
    return input;
  }
  outbox(task) { return readJson(this.filename(task.id, "outbox.json"), 262144, true); }
  summary(task, { output = false, reused = false, uncertain = false } = {}) {
    const box = this.outbox(task), result = task.result;
    const policy = task.permissions?.policy ?? {}, visible = (rules = []) => rules.filter((rule) => ["*", "read", "search", "edit", "write", "execute"].includes(rule));
    const rules = [policy.autoApprove ?? [], policy.autoDeny ?? [], policy.escalate ?? []];
    const command = "'" + path.resolve(this.root, "../../bin/opencode-task").replaceAll("'", "'\"'\"'") + "'";
    const safeText = (text) => typeof text === "string" && !text.includes("tcb_") && (!box || !text.includes(box.url)) ? text : null;
    return { version: 1, key: task.key, task_id: task.id, request_id: task.requestId ?? null,
      accepted: Boolean(task.workerStartedAt), reused, phase: task.phase, step: task.step ?? null,
      dispatch_state: task.dispatchedAt ? "attempted" : uncertain && !result ? "unknown" : "not_reached",
      outcome_unknown: !result && Boolean(task.dispatchedAt || uncertain),
      repo_path: task.git.repo, branch: task.git.branch, worktree: task.cwd ?? null, base: task.git.base, base_sha: task.git.baseSha ?? null,
      session: task.sessionKey ?? null, session_id: task.handle?.backendSessionId ?? null, acpx_record_id: task.handle?.acpxRecordId ?? null,
      started_at: task.startedAt ?? null, continue_from: task.continueFrom ?? null,
      selection: task.model ? { provider: task.model.id.split("/")[0], model: task.model.id.split("/").slice(1).join("/"), variant: task.model.variant ?? null } : null,
      permissions: task.permissions ? { mode: task.permissions.mode, default_action: policy.defaultAction ?? null,
        auto_approve: visible(rules[0]), auto_deny: visible(rules[1]), escalate: visible(rules[2]),
        rules_withheld: rules.flat().length - rules.flatMap(visible).length } : null,
      no_progress_timeout_seconds: task.noProgressMs / 1000, created_at: task.createdAt, last_progress_at: task.progress.at,
      result_status: result?.status ?? null, terminal_source: result?.source ?? null,
      execution_error: task.error ?? null, observation_error: task.observationError ?? null,
      cancel_requested: fs.existsSync(this.filename(task.id, "cancel.request")),
      callback_state: box?.state ?? null, callback_kind: box?.kind ?? null, delivery_error: box?.error ?? null, receipt: box?.receipt ?? null,
      query: { status: `${command} status ${task.id}`, result: `${command} result ${task.id}`, task_directory: path.dirname(this.filename(task.id)) },
      ...(output ? { output: safeText(task.output?.text ?? (result?.outputComplete ? "" : undefined)), output_truncated: task.output?.truncated ?? false,
        output_incomplete: result ? !result.outputComplete : null, callback_output: box ? safeText(JSON.parse(box.body).output) : null } : {}) };
  }
  list({ phase, session, limit = 20 } = {}) {
    if (!Number.isInteger(Number(limit)) || limit < 1 || limit > 50 || phase && !["preparing", "ready", "dispatched", "finished"].includes(phase))
      throw new TaskError("INVALID_ARGUMENTS", { stage: "list", field: "filters", action: "fix_input" });
    const items = [], errors = [];
    for (const id of fs.readdirSync(this.root).filter((id) => taskPattern.test(id))) {
      try {
        const task = this.load(id);
        if ((!phase || task.phase === phase) && (!session || task.sessionKey === session)) items.push(this.summary(task));
      } catch (error) { errors.push({ task_id: id, ...diagnostic(error) }); }
    }
    items.sort((a, b) => b.created_at - a.created_at || a.task_id.localeCompare(b.task_id));
    return { version: 1, items: items.slice(0, Number(limit)), errors, truncated: items.length > limit };
  }
}

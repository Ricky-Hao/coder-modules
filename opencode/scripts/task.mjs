import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readJson, SNAPSHOT_BYTES } from "./task-read.mjs";

export const OUTPUT_BYTES = 32768;
export const DEFAULT_NO_PROGRESS_MS = 900000;
export function noProgressTimeout(seconds = 900) {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400)
    throw new Error("INVALID_NO_PROGRESS_TIMEOUT");
  return seconds * 1000;
}
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const monotonic = () => Number(process.hrtime.bigint()) / 1e6;
const hash = (value) => createHash("sha256").update(value).digest("hex");
// 同 boot/time namespace 才复用单调时间；跨重启保留原墙钟起点。
const clockId = (() => {
  try { return hash(fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8") + fs.readlinkSync("/proc/self/ns/time")); }
  catch { return null; }
})();
const taskPattern = /^task_[a-f0-9]{64}$/;
const callbackPattern = /^tcb_[A-Za-z0-9_-]{43}$/;
const settling = Symbol("canonical result received");

// 仅连接错误触发被动重连；消费/落盘异常须传给控制进程，不能伪装通信断开。
async function* connectionEvents(events) {
  const iterator = events[Symbol.asyncIterator]();
  while (true) {
    let item;
    try { item = await iterator.next(); } catch { return; }
    if (item.done) return;
    yield item.value;
  }
}

export async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("OBSERVATION_TIMEOUT")), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export function deliveryState(record) { return record.callbackState; }
export function privateFile(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.mode & 0o077)
    throw new Error("UNSAFE_TASK_FILE");
  return filename;
}
function directory(dirname) {
  const info = fs.lstatSync(dirname);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error("UNSAFE_TASK_DIRECTORY");
  return dirname;
}
function syncDirectory(dirname) {
  const fd = fs.openSync(dirname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function save(filename, value) {
  if (fs.existsSync(filename)) privateFile(filename);
  const temporary = path.join(directory(path.dirname(filename)), `.write-${randomUUID()}`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  syncDirectory(path.dirname(filename));
}

export function taskPermissions(mode = "deny-all", policy = {}) {
  if (!["deny-all", "approve-reads", "approve-all"].includes(mode) || !policy || typeof policy !== "object" || Array.isArray(policy))
    throw new Error("INVALID_PERMISSIONS");
  const selected = {};
  const names = ["autoApprove", "autoDeny", "escalate", "defaultAction"];
  if (Object.keys(policy).some((key) => !names.includes(key))) throw new Error("INVALID_PERMISSIONS");
  for (const name of names.slice(0, 3)) {
    if (policy[name] === undefined) continue;
    if (!Array.isArray(policy[name]) || policy[name].length > 32 || policy[name].some((rule) =>
      typeof rule !== "string" || !rule.trim() || rule.length > 256 || /[\x00-\x1f\x7f]/.test(rule)))
      throw new Error("INVALID_PERMISSIONS");
    selected[name] = [...policy[name]];
  }
  if (policy.defaultAction !== undefined) {
    if (!["approve", "deny", "escalate"].includes(policy.defaultAction)) throw new Error("INVALID_PERMISSIONS");
    selected.defaultAction = policy.defaultAction;
  }
  return { mode, policy: selected };
}
export function taskModel(model) {
  if (!model || typeof model.id !== "string" || model.id.length > 256 || model.id.includes("tcb_") ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./:-]+$/.test(model.id) ||
      (model.variant !== undefined && (typeof model.variant !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(model.variant))))
    throw new Error("INVALID_MODEL");
  return { id: model.id, ...(model.variant !== undefined ? { variant: model.variant } : {}) };
}
function validateHandle(record, handle) {
  if (!handle || handle.cwd !== record.cwd || handle.sessionKey !== record.sessionKey ||
      !handle.acpxRecordId || handle.backend !== "acpx-shared") throw new Error("SESSION_IDENTITY_CONFLICT");
  return handle;
}
export function validateCallback(input) {
  if (!input || typeof input.callback_id !== "string" || !callbackPattern.test(input.callback_id) || typeof input.callback_url !== "string")
    throw new Error("INVALID_CALLBACK");
  const url = new URL(input.callback_url);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || input.callback_url.includes(input.callback_id) ||
      url.pathname !== "/api/agents/task-callbacks") throw new Error("INVALID_CALLBACK");
  const max = input.max_output_bytes ?? OUTPUT_BYTES;
  if (!Number.isSafeInteger(max) || max < 1 || max > OUTPUT_BYTES) throw new Error("INVALID_CALLBACK");
  return { callback_id: input.callback_id, callback_url: url.toString(), max_output_bytes: max };
}
export function bounded(value, max = OUTPUT_BYTES) {
  return Buffer.from(value).subarray(0, max).toString("utf8").replace(/\uFFFD$/, "");
}
export function callbackBody(callback, status, output) {
  if (!["success", "error", "cancelled"].includes(status)) throw new Error("INVALID_RESULT");
  return { version: 1, callback_id: callback.callback_id, status, output: bounded(output, callback.max_output_bytes ?? OUTPUT_BYTES) };
}
export function appendOutput(record, text, messageId) {
  if (messageId && messageId !== record.outputMessageId) {
    record.outputMessageId = messageId; record.output = ""; record.outputTruncated = false;
  }
  const collected = (record.output ?? "") + text;
  record.output = bounded(collected);
  record.outputTruncated ||= record.output !== collected;
}
const time = (value) => Number.isSafeInteger(value) ? value : null;
function identifier(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value) || value.includes("tcb_"))
    throw new Error("INVALID_TASK_RESULT");
  return value;
}
const safeCodes = new Set(["MODEL_OR_SESSION_SETUP_FAILED", "RECOVERED_BEFORE_DISPATCH", "CONTROL_START_FAILED", "NO_PROGRESS",
  "REQUEST_FAILED", "TURN_TRANSPORT_INTERRUPTED", "REDIRECT_REFUSED", "CALLBACK_REJECTED", "DELIVERY_UNCONFIRMED"]);
function safeCode(value) { return value == null ? null : safeCodes.has(value) ? value : "UNKNOWN_RECORDED_CODE"; }
function choice(value, values) {
  if (value == null) return null;
  if (!values.includes(value)) throw new Error("INVALID_TASK_RESULT");
  return value;
}
function privateText(value, callback) { return value.includes("tcb_") || value.includes(callback.callback_url); }
function sealedBody(record, callback) {
  if (record.body === undefined) return null;
  let payload;
  try { payload = JSON.parse(record.body); } catch { throw new Error("INVALID_TASK_RESULT"); }
  if (typeof record.body !== "string" || !["outbox", "delivered", "rejected"].includes(record.callbackState) ||
      !payload || payload.version !== 1 || payload.callback_id !== callback.callback_id ||
      !["success", "error", "cancelled"].includes(payload.status) || typeof payload.output !== "string" ||
      Object.keys(payload).some((name) => !["version", "callback_id", "status", "output"].includes(name)))
    throw new Error("INVALID_TASK_RESULT");
  return payload;
}
function resultOutput(result, callback) {
  const text = result?.output;
  if (text !== undefined && typeof text !== "string") throw new Error("INVALID_TASK_RESULT");
  const hidden = text !== undefined && privateText(text, callback);
  const output = text === undefined || hidden ? null : bounded(text, callback.max_output_bytes);
  return { output, output_bytes: output === null ? null : Buffer.byteLength(output),
    output_limit_bytes: callback.max_output_bytes, output_truncated: text === undefined ? null : Boolean(result.truncated || output !== text),
    output_available: output !== null, ...(hidden ? { output_error: "PRIVATE_CALLBACK_CONTENT" } : {}) };
}
function resultReceipt(value, callback) {
  if (value == null) return null;
  if (value.version !== 1 || typeof value.receipt_id !== "string" || !value.receipt_id || Buffer.byteLength(value.receipt_id) > 256 ||
      typeof value.accepted_at !== "string" || Buffer.byteLength(value.accepted_at) > 256 ||
      !Number.isFinite(Date.parse(value.accepted_at)) || privateText(value.receipt_id + value.accepted_at, callback))
    throw new Error("INVALID_TASK_RESULT");
  return { receipt_id: value.receipt_id, accepted_at: value.accepted_at };
}
export function retryDelay(attempt, retryAfter, now) {
  const seconds = /^\d+$/.test(retryAfter ?? "") ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? "") - now;
  return Math.min(86400000, Math.max(Math.min(300000, 5000 * 2 ** Math.min(attempt, 10)), Number.isFinite(seconds) ? seconds : 0));
}
async function receipt(response) {
  if (!response.body) throw new Error("INVALID_RECEIPT");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw new Error("INVALID_RECEIPT");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  resultReceipt(value, { callback_url: "\0" });
  return { version: 1, receipt_id: value.receipt_id, accepted_at: value.accepted_at };
}

export class TaskRunner {
  constructor({ root, runtime, fetcher = fetch, now = Date.now, tick = monotonic, clock = clockId,
    noProgressMs = DEFAULT_NO_PROGRESS_MS, pollMs = 200, ioMs = 3000, drainMs = 250 }) {
    this.root = directory(root); this.runtime = runtime; this.fetcher = fetcher;
    this.now = now; this.tick = tick; this.clock = clock;
    this.noProgressMs = noProgressMs; this.pollMs = pollMs; this.ioMs = ioMs; this.drainMs = drainMs;
  }
  filename(id, name = "task.json") {
    if (!taskPattern.test(id)) throw new Error("INVALID_TASK_ID");
    return path.join(directory(path.join(this.root, id)), name);
  }
  load(id, options) {
    const record = readJson(this.filename(id), undefined, options);
    if (!record || record.id !== id) throw new Error("INVALID_TASK_RESULT");
    if (record.version !== 2 || !record.model || !path.isAbsolute(record.modelConfig ?? "") ||
        !["env", "external"].includes(record.modelProfile) || !record.permissions || !Number.isSafeInteger(record.createdAt) ||
        !Number.isSafeInteger(record.noProgressMs) || record.noProgressMs < 1 || record.noProgressMs > 86400000 ||
        !Number.isSafeInteger(record.progress?.at) || !Number.isFinite(record.progress?.tick) ||
        record.result && (typeof record.result.truncated !== "boolean" || !Number.isSafeInteger(record.result.at) ||
          typeof record.result.output !== "string" || !record.result.status || !record.result.source || !record.result.outputSource))
      throw new Error("UNSUPPORTED_TASK_RECORD");
    if (!record.requestId || !record.sessionKey || typeof record.prompt !== "string" || !record.prompt ||
        !path.isAbsolute(record.cwd ?? "") || Boolean(record.result) !== (record.state === "completed") ||
        record.callbackState !== undefined && record.body === undefined) throw new Error("INVALID_TASK_RESULT");
    taskModel(record.model); taskPermissions(record.permissions.mode, record.permissions.policy);
    if (record.handle) validateHandle(record, record.handle);
    this.resultRecord(record, { output: false });
    return record;
  }
  write(record) { save(this.filename(record.id), record); }
  bindSession({ cwd, session, model, modelConfig, modelProfile }) {
    const sessions = path.join(this.root, ".sessions");
    try {
      fs.mkdirSync(sessions, { mode: 0o700 });
      save(path.join(sessions, "owner.json"), { schema: 1, uid: process.getuid() }); syncDirectory(this.root);
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    directory(sessions);
    if (JSON.stringify(readJson(path.join(sessions, "owner.json"))) !== JSON.stringify({ schema: 1, uid: process.getuid() }))
      throw new Error("INVALID_SESSION_OWNER");
    const binding = path.join(sessions, `${hash(session)}.json`);
    const sessionKey = `module-task-session_${hash(JSON.stringify([cwd, session]))}`;
    if (fs.existsSync(binding)) {
      const prior = readJson(binding);
      if (prior.version !== 2) throw new Error("UNSUPPORTED_SESSION_RECORD");
      if (prior.cwd !== cwd || prior.name !== session || prior.sessionKey !== sessionKey) throw new Error("SESSION_CWD_CONFLICT");
      if (JSON.stringify(prior.model) !== JSON.stringify(model) || prior.modelConfig !== modelConfig || prior.modelProfile !== modelProfile)
        throw new Error("SESSION_MODEL_CONFLICT");
    } else save(binding, { version: 2, name: session, cwd, sessionKey, model, modelConfig, modelProfile });
    return sessionKey;
  }
  submit({ key, prompt, cwd, callback, session, permissionMode, permissionPolicy, model, modelConfig, modelProfile,
    launch, continuationHandle, noProgressMs = this.noProgressMs }) {
    if (typeof key !== "string" || !key || key.length > 256 || typeof prompt !== "string" || !prompt || Buffer.byteLength(prompt) > 1048576)
      throw new Error("INVALID_SUBMIT");
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("INVALID_CWD");
    cwd = fs.realpathSync(cwd);
    const permissions = taskPermissions(permissionMode, permissionPolicy);
    model = taskModel(model);
    if (typeof modelConfig !== "string" || !path.isAbsolute(modelConfig)) throw new Error("TASK_MODEL_CONFIG_REQUIRED");
    if (!["env", "external"].includes(modelProfile)) throw new Error("INVALID_MODEL_PROFILE");
    if (!Number.isSafeInteger(noProgressMs) || noProgressMs < 1 || noProgressMs > 86400000) throw new Error("INVALID_NO_PROGRESS_TIMEOUT");
    if (session !== undefined && (typeof session !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session)))
      throw new Error("INVALID_SESSION");
    const selected = validateCallback(callback);
    if (/tcb_[A-Za-z0-9_-]{43}/.test(prompt) || prompt.includes(selected.callback_id) ||
        prompt.includes(callback.callback_url) || prompt.includes(selected.callback_url)) throw new Error("CALLBACK_IN_PROMPT");
    const id = `task_${hash(key)}`;
    const sessionKey = session === undefined ? id : this.bindSession({ cwd, session, model, modelConfig, modelProfile });
    const fingerprint = hash(JSON.stringify({ prompt, cwd, callback: selected, sessionKey, permissions, launch, continuationHandle,
      model, modelConfig, modelProfile, noProgressMs }));
    const dirname = path.join(this.root, id);
    try { fs.mkdirSync(dirname, { mode: 0o700 }); syncDirectory(this.root); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    directory(dirname);
    let record;
    if (fs.existsSync(path.join(dirname, "task.json"))) {
      record = this.load(id);
      if (record.fingerprint !== fingerprint) throw new Error("SUBMIT_CONFLICT");
    } else {
      record = { version: 2, id, fingerprint, requestId: randomUUID(), sessionKey, sessionName: session,
        permissions, launch, continuationHandle, model, modelConfig, modelProfile, cwd, prompt, callback: selected,
        state: "queued", createdAt: this.now(), noProgressMs,
        progress: { at: this.now(), tick: this.tick(), clock: this.clock } };
      this.write(record);
    }
    return { version: 1, task_id: id, request_id: record.requestId, accepted: true };
  }
  status(id) {
    const record = this.load(id);
    return { ...this.resultRecord(record, { output: false }),
      permission_mode: choice(record.permissions.mode, ["deny-all", "approve-reads", "approve-all"]),
      model: taskModel(record.model).id, variant: identifier(record.model.variant),
      cancel_requested: readJson(this.filename(id, "cancel.json"), SNAPSHOT_BYTES, { optional: true }) !== undefined,
      execution_error: safeCode(record.executionError), delivery_error: safeCode(record.deliveryError) };
  }
  result(id) { return this.resultRecord(this.load(id)); }
  resultRecord(record, { output = true } = {}) {
    let callback;
    try { callback = validateCallback(record.callback); } catch { throw new Error("INVALID_TASK_RESULT"); }
    const payload = sealedBody(record, callback), result = record.result;
    const source = result ? choice(result.source, ["turn.result", "watchSession.turn_result", "queued_cancellation", "execution_setup_failure"]) : null;
    const outputSource = result ? choice(result.outputSource, ["assistant_output", "program_generated"]) : null;
    return { version: 1, task_id: identifier(record.id), request_id: identifier(record.requestId), session_name: identifier(record.sessionName),
      session_key: identifier(record.sessionKey), session_id: identifier(record.handle?.backendSessionId), acpx_record_id: identifier(record.handle?.acpxRecordId),
      state: choice(record.state, ["queued", "preparing", "dispatching", "running", "ambiguous", "completed"]),
      result_status: result ? choice(result.status, ["success", "error", "cancelled"]) : null,
      callback_status: payload?.status ?? null, callback_state: payload ? record.callbackState : null,
      callback_kind: payload ? choice(record.notificationKind, ["no_progress", "request_result"]) : null,
      no_progress_timeout_seconds: record.noProgressMs / 1000, last_progress_at: record.progress.at,
      timing: { time_basis: "unix_epoch_ms_wall_clock", accepted_at: record.createdAt, started_at: time(record.startedAt),
        terminal_at: time(result?.at), callback_attempted_at: time(record.callbackAttemptedAt),
        callback_delivered_at: time(record.callbackDeliveredAt), notification_at: time(record.notificationAt) },
      ...(output ? { ...resultOutput(result, callback), callback_output: payload && !privateText(payload.output, callback)
        ? bounded(payload.output, callback.max_output_bytes) : null } : {}),
      evidence: { lifecycle: "program_observed", terminal_source: source, output_source: outputSource,
        callback_receipt: resultReceipt(record.receipt, callback) } };
  }
  pending(unsupported = []) {
    return fs.readdirSync(this.root).filter((id) => taskPattern.test(id)).filter((id) => {
      try {
        const record = this.load(id);
        return !record.result || record.callbackState === "outbox";
      } catch (error) {
        if (error.message !== "UNSUPPORTED_TASK_RECORD") throw error;
        unsupported.push({ task_id: id, code: error.message }); return false;
      }
    });
  }
  sealCallback(record, status, output, kind) {
    if (record.body !== undefined) return;
    record.body = JSON.stringify(callbackBody(record.callback, status, output));
    record.callbackState = "outbox"; record.notificationKind = kind;
    record.attempts = 0; record.nextAttemptAt = this.now();
  }
  seal(record, status, output, source = "turn.result", outputSource = "assistant_output") {
    if (record.result) return;
    const text = bounded(output, record.callback.max_output_bytes);
    record.result = { status, output: text, truncated: text !== output || (outputSource === "assistant_output" && Boolean(record.outputTruncated)),
      at: this.now(), source, outputSource };
    record.state = "completed";
    this.sealCallback(record, status, text, "request_result");
    delete record.output;
    this.write(record);
  }
  fail(record, reason) {
    if (record.result) return;
    record.executionError = reason;
    this.seal(record, "error", `Task did not dispatch a prompt: ${reason}.`, "execution_setup_failure", "program_generated");
  }
  notify(record) {
    if (record.body !== undefined || record.result) return;
    if (["queued", "preparing"].includes(record.state)) { this.fail(record, "NO_PROGRESS"); return; }
    record.state = "ambiguous"; record.executionError = "NO_PROGRESS"; record.notificationAt = this.now();
    this.sealCallback(record, "error", "Original request outcome and side effects are unknown. It may still be running. No original request progress was observed within the configured timeout. Do not automatically retry or cancel; verify the original request before further action.", "no_progress");
    // 继续保存原 output/cursor；晚到结果独立保存，不能改已封存通知。
    this.write(record);
  }
  progress(record) {
    if (!record.body && !record[settling] && this.remaining(record) <= 0) this.notify(record);
    record.progress = { at: this.now(), tick: this.tick(), clock: this.clock };
  }
  remaining(record) {
    const saved = record.progress;
    const elapsed = this.clock && saved.clock === this.clock && saved.tick <= this.tick()
      ? this.tick() - saved.tick : Math.max(0, this.now() - saved.at);
    return record.noProgressMs - elapsed;
  }
  finish(record, result, source = "turn.result") {
    // 共享连接 failed 不等于 canonical 失败；只用原 journal 的失败结果。
    if (result.status === "failed" && (source === "turn.result" || result.error?.detailCode === "WATCH_OUTCOME_UNKNOWN")) return false;
    const status = result.status === "completed" ? "success" : result.status === "cancelled" ? "cancelled" : "error";
    if (status === "error") {
      record.executionError = "REQUEST_FAILED";
      this.seal(record, status, "Original request failed (REQUEST_FAILED). Side effects may have occurred; verify before retrying.", source, "program_generated");
    } else {
      delete record.executionError;
      this.seal(record, status, record.output ?? "", source);
    }
    return true;
  }
  async deliver(record) {
    if (record.callbackState !== "outbox" || record.nextAttemptAt > this.now()) return;
    const body = record.body;
    let retryAfter;
    record.callbackAttemptedAt = this.now(); this.write(record);
    try {
      const response = await this.fetcher(record.callback.callback_url, { method: "POST", headers: { "Content-Type": "application/json" },
        body, redirect: "manual", signal: AbortSignal.timeout(30000) });
      if (response.status === 202) {
        record.receipt = await receipt(response); record.callbackDeliveredAt = this.now(); record.callbackState = "delivered";
        delete record.deliveryError;
      } else {
        retryAfter = response.headers.get("retry-after"); await response.body?.cancel();
        if (![408, 425, 429].includes(response.status) && response.status < 500) {
          record.callbackState = "rejected";
          record.deliveryError = response.status >= 300 && response.status < 400 ? "REDIRECT_REFUSED" : "CALLBACK_REJECTED";
        }
      }
    } catch { record.deliveryError = "DELIVERY_UNCONFIRMED"; }
    if (record.callbackState === "outbox") record.nextAttemptAt = this.now() + retryDelay(record.attempts++, retryAfter, this.now());
    this.write(record);
  }
  async journal(record, signal) {
    while (!signal.aborted && !record.result) {
      if (!record.handle) {
        let handle;
        try { handle = await within(this.runtime.findSession({ sessionKey: record.sessionKey, agent: "opencode", cwd: record.cwd }), this.ioMs); }
        catch { /* 沿剩余期限重试被动查找。 */ }
        if (signal.aborted) return;
        if (!handle) { await delay(this.pollMs); continue; }
        record.handle = validateHandle(record, handle);
      }
      for await (const event of connectionEvents(this.runtime.watchSession({ handle: record.handle, cursor: record.cursor, signal }))) {
          if (signal.aborted || record.result) return;
          if (event.requestId === record.requestId) {
            const unknown = event.type === "turn_result" && event.result.error?.detailCode === "WATCH_OUTCOME_UNKNOWN";
            if (!unknown && ["turn_started", "message", "turn_result"].includes(event.type)) {
              this.progress(record);
              const update = event.message?.params?.update;
              if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
                appendOutput(record, update.content.text, update.messageId);
              if (event.type === "turn_result") {
                record.cursor = event.cursor;
                this.finish(record, event.result, "watchSession.turn_result"); return;
              }
            }
          }
          record.cursor = event.cursor; this.write(record);
      }
      await delay(this.pollMs);
    }
  }
  async executeRecord(record, observeOnly, signal, onError) {
    if (record.result) return;
    if (["queued", "preparing"].includes(record.state)) {
      if (fs.existsSync(this.filename(record.id, "cancel.json"))) {
        this.seal(record, "cancelled", "Task cancelled before execution.", "queued_cancellation", "program_generated"); return;
      }
      if (this.remaining(record) <= 0) { this.notify(record); return; }
      if (observeOnly || record.state === "preparing") { this.fail(record, "RECOVERED_BEFORE_DISPATCH"); return; }
      record.state = "preparing"; this.write(record);
      try {
        const handle = await this.runtime.ensureSession({ sessionKey: record.sessionKey, agent: "opencode", mode: "persistent", cwd: record.cwd, model: record.model });
        if (signal.aborted || record.result) return;
        record.handle = validateHandle(record, handle);
      } catch {
        if (!signal.aborted && !record.result) this.fail(record, "MODEL_OR_SESSION_SETUP_FAILED");
        return;
      }
      if (fs.existsSync(this.filename(record.id, "cancel.json"))) {
        this.seal(record, "cancelled", "Task cancelled before execution.", "queued_cancellation", "program_generated"); return;
      }
      if (this.remaining(record) <= 0) { this.notify(record); return; }
      record.state = "dispatching"; record.dispatchedAt = this.now(); this.write(record);
      let turn;
      try {
        turn = this.runtime.startTurn({ handle: record.handle, text: record.prompt, mode: "prompt", requestId: record.requestId });
      } catch {
        record.state = "ambiguous"; record.executionError = "TURN_TRANSPORT_INTERRUPTED"; this.write(record);
      }
      if (turn) {
        const stream = {};
        const active = () => !signal.aborted && !record.result;
        Promise.resolve(turn.promptStarted).then(() => {
          if (!active()) return;
          if (!record.body) record.state = "running";
          record.startedAt ??= this.now(); this.progress(record); this.write(record);
        }, () => {}).catch(onError);
        const consume = (async () => {
          for await (const event of connectionEvents(turn.events)) {
            if (!active()) break;
            if (event.requestId !== undefined && event.requestId !== record.requestId) continue;
            this.progress(record);
            if (event.type === "text_delta" && event.stream !== "thought") appendOutput(stream, event.text, event.messageId);
            this.write(record);
          }
        })();
        consume.catch(onError);
        const journal = this.journal(record, signal);
        Promise.resolve(turn.result).then(async (result) => {
          if (!active() || result.status === "failed") return;
          if (!record.body && this.remaining(record) <= 0) this.notify(record);
          record[settling] = true; // 仅进程内：终态已到，排空不触发超时；不能保存成恢复授权。
          await within(consume, this.drainMs).catch(() => {});
          if (!active()) return;
          if (stream.output !== undefined) { record.output = stream.output; record.outputTruncated = stream.outputTruncated; }
          this.finish(record, result);
        }, () => {}).catch(onError);
        await journal;
        return;
      }
    }
    if (record.handle) validateHandle(record, record.handle);
    await this.journal(record, signal);
  }
  async control(id, { observeOnly = false, signal, deliver = true } = {}) {
    const record = this.load(id), controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    let delivery, cancellation, failure;
    // 同一对象由一个进程更新；网络等待不阻塞事件消费、超时或晚到结果落盘。
    this.executeRecord(record, observeOnly, controller.signal, (error) => { failure = error; }).catch((error) => { failure = error; });
    try {
      while (!controller.signal.aborted) {
        if (failure) throw failure;
        if (!record.result && !record[settling] && !record.body && this.remaining(record) <= 0) this.notify(record);
        if (deliver && !delivery && record.callbackState === "outbox" && record.nextAttemptAt <= this.now()) {
          delivery = this.deliver(record).catch((error) => { failure = error; }).finally(() => { delivery = undefined; });
        }
        if (!record.result && record.dispatchedAt && !cancellation && fs.existsSync(this.filename(id, "cancel.json"))) {
          cancellation = within(Promise.resolve(this.runtime.cancelRequest?.({ handle: record.handle, requestId: record.requestId })), this.ioMs)
            .catch(() => {}).finally(() => { cancellation = undefined; });
        }
        if (record.result && (!deliver || record.callbackState !== "outbox") && !delivery) return;
        await delay(this.pollMs);
      }
    } finally {
      controller.abort(); signal?.removeEventListener("abort", stop);
    }
  }
  // 内部测试/适配原语；公开 CLI 只由 launch 或显式 recover 启动 control。
  async execute(id, options = {}) { return this.control(id, { ...options, deliver: false }); }
  async cancel(id) {
    const record = this.load(id);
    if (record.result) throw new Error("TASK_TERMINAL");
    save(this.filename(id, "cancel.json"), { requested: true });
    if (record.handle && record.dispatchedAt) {
      validateHandle(record, record.handle);
      await within(Promise.resolve(this.runtime.cancelRequest?.({ handle: record.handle, requestId: record.requestId })), this.ioMs);
    }
  }
}

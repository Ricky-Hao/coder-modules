import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readJson, SNAPSHOT_BYTES } from "./task-read.mjs";

export const OUTPUT_BYTES = 32768;
export const HEALTH_DEFAULTS = Object.freeze({
  pollMs: 5000,
  probeMs: 3000,
  discoveryMs: 30000,
  setupMs: 30000,
  workerMs: 30000,
  confirmMs: 30000,
  progressMs: 900000,
  toolMs: 21600000,
  drainMs: 250,
});
export function healthPolicy(env = {}) {
  const selected = {};
  for (const [key, fallback] of Object.entries(HEALTH_DEFAULTS)) {
    const value = env[`OPENCODE_TASK_${key.replace(/Ms$/, "_MS").toUpperCase()}`];
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(number) || number < 10 || number > 86400000)
      throw new Error("INVALID_TASK_HEALTH_POLICY");
    selected[key] = number;
  }
  if (selected.workerMs < selected.pollMs * 3 || selected.discoveryMs < selected.probeMs)
    throw new Error("INVALID_TASK_HEALTH_POLICY");
  return selected;
}
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const monotonic = () => Number(process.hrtime.bigint()) / 1e6;
// 同 boot/time namespace 才复用单调时间。
const clockId = (() => {
  try {
    return createHash("sha256").update(fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8") +
      fs.readlinkSync("/proc/self/ns/time")).digest("hex");
  } catch { return null; }
})();

export class Confirmation {
  constructor(policy, tick = monotonic) {
    this.policy = policy;
    this.tick = tick;
  }
  update(reason) {
    const at = this.tick();
    // 长暂停后重新确认。
    if (!reason || this.lastCheck !== undefined && at - this.lastCheck > 2 * (this.policy.pollMs + this.policy.probeMs)) {
      this.since = undefined;
      this.samples = 0;
    }
    this.lastCheck = at;
    this.reason = reason;
    if (!reason) return false;
    this.since ??= at;
    this.samples = (this.samples ?? 0) + 1;
    return this.samples >= 2 && at - this.since >= this.policy.confirmMs;
  }
}
export async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("OBSERVATION_TIMEOUT")), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
export function deliveryState(record) {
  return record.notificationState ?? record.state;
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const taskPattern = /^task_[a-f0-9]{64}$/;
const callbackPattern = /^tcb_[A-Za-z0-9_-]{43}$/;

export function privateFile(filename) {
  const info = fs.lstatSync(filename);
  if (
    !info.isFile() ||
    info.uid !== process.getuid() ||
    info.nlink !== 1 ||
    info.mode & 0o077
  )
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
  const fd = fs.openSync(
    dirname,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function save(filename, value) {
  if (fs.existsSync(filename)) privateFile(filename);
  const temporary = path.join(
    directory(path.dirname(filename)),
    `.write-${randomUUID()}`,
  );
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  syncDirectory(path.dirname(filename));
}

export function taskPermissions(mode = "deny-all", policy = {}) {
  if (
    !["deny-all", "approve-reads", "approve-all"].includes(mode) ||
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy)
  )
    throw new Error("INVALID_PERMISSIONS");
  const selected = {};
  const names = ["autoApprove", "autoDeny", "escalate", "defaultAction"];
  if (Object.keys(policy).some((key) => !names.includes(key)))
    throw new Error("INVALID_PERMISSIONS");
  for (const name of names.slice(0, 3)) {
    if (policy[name] === undefined) continue;
    if (
      !Array.isArray(policy[name]) ||
      policy[name].length > 32 ||
      policy[name].some(
        (rule) =>
          typeof rule !== "string" ||
          !rule.trim() ||
          rule.length > 256 ||
          /[\x00-\x1f\x7f]/.test(rule),
      )
    )
      throw new Error("INVALID_PERMISSIONS");
    selected[name] = [...policy[name]];
  }
  if (policy.defaultAction !== undefined) {
    if (!["approve", "deny", "escalate"].includes(policy.defaultAction))
      throw new Error("INVALID_PERMISSIONS");
    selected.defaultAction = policy.defaultAction;
  }
  return { mode, policy: selected };
}

export function taskModel(model) {
  if (
    !model || typeof model.id !== "string" || model.id.length > 256 || model.id.includes("tcb_") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./:-]+$/.test(model.id) ||
    (model.variant !== undefined && (typeof model.variant !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(model.variant)))
  )
    throw new Error("INVALID_MODEL");
  return { id: model.id, ...(model.variant !== undefined ? { variant: model.variant } : {}) };
}

function validateHandle(record, handle) {
  if (
    !handle ||
    handle.cwd !== record.cwd ||
    handle.sessionKey !== record.sessionKey ||
    !handle.acpxRecordId ||
    handle.backend !== "acpx-shared"
  )
    throw new Error("SESSION_IDENTITY_CONFLICT");
  return handle;
}

export function validateCallback(input) {
  if (
    !input ||
    typeof input.callback_id !== "string" ||
    !callbackPattern.test(input.callback_id) ||
    typeof input.callback_url !== "string"
  )
    throw new Error("INVALID_CALLBACK");
  const url = new URL(input.callback_url);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    input.callback_url.includes(input.callback_id) ||
    url.pathname !== "/api/agents/task-callbacks"
  )
    throw new Error("INVALID_CALLBACK");
  const max = input.max_output_bytes ?? OUTPUT_BYTES;
  if (!Number.isSafeInteger(max) || max < 1 || max > OUTPUT_BYTES)
    throw new Error("INVALID_CALLBACK");
  return {
    callback_id: input.callback_id,
    callback_url: url.toString(),
    max_output_bytes: max,
  };
}

export function callbackBody(callback, status, output) {
  if (!["success", "error", "cancelled"].includes(status))
    throw new Error("INVALID_RESULT");
  return {
    version: 1,
    callback_id: callback.callback_id,
    status,
    output: bounded(output, callback.max_output_bytes ?? OUTPUT_BYTES),
  };
}

export function bounded(value, max = OUTPUT_BYTES) {
  return Buffer.from(value)
    .subarray(0, max)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function boundedInfo(value, max = OUTPUT_BYTES) {
  const text = bounded(value, max);
  return {
    text,
    bytes: Buffer.byteLength(text),
    truncated: text !== value,
  };
}

function time(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function identifier(value) {
  if (value == null) return null;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value) ||
    value.includes("tcb_")
  )
    throw new Error("INVALID_TASK_RESULT");
  return value;
}

const safeCodes = new Set([
  "SETUP_SLOW", "MODEL_OR_SESSION_SETUP_FAILED", "WORKER_LOST_BEFORE_DISPATCH", "WORKER_START_FAILED",
  "WORKER_EXITED", "WORKER_UNRESPONSIVE", "WORKER_HEARTBEAT_UNREADABLE", "SUPERVISOR_START_FAILED",
  "ORIGINAL_SESSION_UNAVAILABLE", "OWNER_CHANGED", "OWNER_UNAVAILABLE", "JOURNAL_UNAVAILABLE",
  "PROGRESS_UNCONFIRMED", "REQUEST_UNOBSERVABLE", "REQUEST_OUTCOME_UNKNOWN", "TURN_FAILED_UNCONFIRMED",
  "REQUEST_FAILED", "AGENT_DISCONNECTED", "TURN_TRANSPORT_INTERRUPTED", "REDIRECT_REFUSED",
  "CALLBACK_REJECTED", "DELIVERY_UNCONFIRMED",
]);

function safeCode(value) {
  if (value == null) return null;
  return safeCodes.has(value) ? value : "UNKNOWN_RECORDED_CODE";
}

function resultChoice(value, choices) {
  if (value == null) return null;
  if (!choices.includes(value)) throw new Error("INVALID_TASK_RESULT");
  return value;
}

function resultCallback(record) {
  try {
    return validateCallback(record.callback);
  } catch {
    throw new Error("INVALID_TASK_RESULT");
  }
}

function timing(record) {
  return {
    time_basis: "unix_epoch_ms_wall_clock",
    accepted_at: time(record.createdAt),
    started_at: time(record.startedAt),
    terminal_at: time(record.terminalAt),
    callback_attempted_at: time(record.callbackAttemptedAt),
    callback_delivered_at: time(record.callbackDeliveredAt),
    supervision_failed_at: time(record.supervisionFailedAt),
  };
}

function sealedResult(record, callback) {
  if (record.body === undefined) return null;
  if (
    typeof record.body !== "string" ||
    !["outbox", "delivered", "rejected"].includes(deliveryState(record))
  )
    throw new Error("INVALID_TASK_RESULT");
  let value;
  try {
    value = JSON.parse(record.body);
  } catch {
    throw new Error("INVALID_TASK_RESULT");
  }
  if (
    !value ||
    value.version !== 1 ||
    value.callback_id !== callback.callback_id ||
    !["success", "error", "cancelled"].includes(value.status) ||
    typeof value.output !== "string"
  )
    throw new Error("INVALID_TASK_RESULT");
  return value;
}

function privateResultText(value, callback) {
  return value.includes("tcb_") || value.includes(callback.callback_url);
}

function resultOutput(record, payload, callback) {
  const limit = callback.max_output_bytes;
  if (!payload)
    return {
      output: null,
      output_bytes: null,
      output_limit_bytes: limit,
      output_truncated: null,
      output_available: false,
    };
  const boundedOutput = boundedInfo(payload.output, limit);
  // 先查完整文本，避免裁剪隐藏 bearer。
  const privateOutput = privateResultText(payload.output, callback);
  return {
    output: privateOutput ? null : boundedOutput.text,
    output_bytes: privateOutput ? null : boundedOutput.bytes,
    output_limit_bytes: limit,
    output_truncated: boundedOutput.truncated || record.outputTruncated,
    output_available: !privateOutput,
    ...(privateOutput ? { output_error: "PRIVATE_CALLBACK_CONTENT" } : {}),
  };
}

function resultReceipt(value, callback) {
  if (value == null) return null;
  if (
    value.version !== 1 ||
    typeof value.receipt_id !== "string" ||
    !value.receipt_id || Buffer.byteLength(value.receipt_id) > 256 ||
    typeof value.accepted_at !== "string" ||
    Buffer.byteLength(value.accepted_at) > 256 ||
    !Number.isFinite(Date.parse(value.accepted_at))
  )
    throw new Error("INVALID_TASK_RESULT");
  if (privateResultText(value.receipt_id + value.accepted_at, callback))
    throw new Error("INVALID_TASK_RESULT");
  return { receipt_id: value.receipt_id, accepted_at: value.accepted_at };
}

function evidence(record, payload, callback) {
  return {
    lifecycle: "program_observed",
    terminal_source: payload ? resultChoice(record.terminalSource, [
      "turn.result", "watchSession.turn_result", "queued_cancellation",
      "execution_setup_failure", "supervision_failure",
    ]) : null,
    output_source: payload ? resultChoice(record.outputSource, [
      "assistant_output", "program_generated",
    ]) : null,
    callback_receipt: resultReceipt(record.receipt, callback),
  };
}

export function appendOutput(record, text, messageId) {
  if (messageId && messageId !== record.outputMessageId) {
    record.outputMessageId = messageId;
    record.output = "";
    record.outputTruncated = false;
  }
  const collected = boundedInfo((record.output ?? "") + text);
  if (collected.truncated) record.outputTruncated = true;
  record.output = collected.text;
}

function terminalStatus(result) {
  if (result.status === "completed") return "success";
  if (result.status === "cancelled") return "cancelled";
  return "error";
}

export function retryDelay(attempt, retryAfter, now) {
  const seconds = /^\d+$/.test(retryAfter ?? "")
    ? Number(retryAfter) * 1000
    : Date.parse(retryAfter ?? "") - now;
  return Math.min(
    86400000,
    Math.max(
      Math.min(300000, 5000 * 2 ** Math.min(attempt, 10)),
      Number.isFinite(seconds) ? seconds : 0,
    ),
  );
}

async function receipt(response) {
  if (!response.body) throw new Error("INVALID_RECEIPT");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw new Error("INVALID_RECEIPT");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    value.version !== 1 ||
    typeof value.receipt_id !== "string" ||
    value.receipt_id.length > 256 ||
    !value.receipt_id ||
    !Number.isFinite(Date.parse(value.accepted_at))
  )
    throw new Error("INVALID_RECEIPT");
  return {
    version: 1,
    receipt_id: value.receipt_id,
    accepted_at: value.accepted_at,
  };
}

export class TaskRunner {
  constructor({ root, runtime, fetcher = fetch, now = Date.now, policy = HEALTH_DEFAULTS, heartbeat = () => {},
    tick = monotonic, clock = clockId }) {
    this.root = directory(root);
    this.runtime = runtime;
    this.fetcher = fetcher;
    this.now = now;
    this.policy = policy;
    this.heartbeat = heartbeat;
    this.tick = tick;
    this.clock = clock;
  }
  filename(id, name = "task.json") {
    if (!taskPattern.test(id)) throw new Error("INVALID_TASK_ID");
    return path.join(directory(path.join(this.root, id)), name);
  }
  load(id, options) {
    const record = readJson(this.filename(id), undefined, options);
    if (!record || record.id !== id) throw new Error("INVALID_TASK_RESULT");
    if (record.version !== 1 || !record.model || !path.isAbsolute(record.modelConfig ?? "") ||
        !["env", "external"].includes(record.modelProfile) || !record.permissions ||
        !Number.isSafeInteger(record.createdAt) || record.terminalSource === "operator_resolution" ||
        record.body !== undefined && typeof record.outputTruncated !== "boolean")
      throw new Error("UNSUPPORTED_TASK_RECORD");
    return record;
  }
  write(record) {
    save(this.filename(record.id), record);
  }
  bindSession({ cwd, session, model, modelConfig, modelProfile }) {
    const sessions = path.join(this.root, ".sessions");
    try {
      fs.mkdirSync(sessions, { mode: 0o700 });
      save(path.join(sessions, "owner.json"), { schema: 1, uid: process.getuid() });
      syncDirectory(this.root);
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    directory(sessions);
    if (JSON.stringify(readJson(path.join(sessions, "owner.json"))) !== JSON.stringify({ schema: 1, uid: process.getuid() }))
      throw new Error("INVALID_SESSION_OWNER");
    const binding = path.join(sessions, `${hash(session)}.json`);
    const sessionKey = `module-task-session_${hash(JSON.stringify([cwd, session]))}`;
    if (fs.existsSync(binding)) {
      const prior = readJson(binding);
      if (prior.cwd !== cwd || prior.name !== session || prior.sessionKey !== sessionKey)
        throw new Error("SESSION_CWD_CONFLICT");
      if (JSON.stringify(prior.model) !== JSON.stringify(model) || prior.modelConfig !== modelConfig ||
          prior.modelProfile !== modelProfile) throw new Error("SESSION_MODEL_CONFLICT");
    } else save(binding, { version: 1, name: session, cwd, sessionKey,
      model, modelConfig, modelProfile });
    return sessionKey;
  }
  submit({
    key,
    prompt,
    cwd,
    callback,
    session,
    permissionMode,
    permissionPolicy,
    model,
    modelConfig,
    modelProfile,
    launch,
    continuationHandle,
  }) {
    if (
      typeof key !== "string" ||
      !key ||
      key.length > 256 ||
      typeof prompt !== "string" ||
      !prompt ||
      Buffer.byteLength(prompt) > 1048576
    )
      throw new Error("INVALID_SUBMIT");
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory())
      throw new Error("INVALID_CWD");
    cwd = fs.realpathSync(cwd);
    const permissions = taskPermissions(permissionMode, permissionPolicy);
    model = taskModel(model);
    if (typeof modelConfig !== "string" || !path.isAbsolute(modelConfig))
      throw new Error("TASK_MODEL_CONFIG_REQUIRED");
    if (!["env", "external"].includes(modelProfile))
      throw new Error("INVALID_MODEL_PROFILE");
    if (
      session !== undefined &&
      (typeof session !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session))
    )
      throw new Error("INVALID_SESSION");
    const selected = validateCallback(callback);
    if (
      /tcb_[A-Za-z0-9_-]{43}/.test(prompt) ||
      prompt.includes(selected.callback_id) ||
      prompt.includes(callback.callback_url) ||
      prompt.includes(selected.callback_url)
    )
      throw new Error("CALLBACK_IN_PROMPT");
    const id = `task_${hash(key)}`;
    let sessionKey = id;
    if (session !== undefined) sessionKey = this.bindSession({ cwd, session, model, modelConfig, modelProfile });
    const fingerprint = hash(
      JSON.stringify({
        prompt,
        cwd,
        callback: selected,
        sessionKey,
        permissions,
        ...(launch ? { launch } : {}),
        ...(continuationHandle ? { continuationHandle } : {}),
        model, modelConfig, modelProfile,
      }),
    );
    const dirname = path.join(this.root, id);
    try {
      fs.mkdirSync(dirname, { mode: 0o700 });
      syncDirectory(this.root);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    directory(dirname);
    const filename = path.join(dirname, "task.json");
    let record;
    if (fs.existsSync(filename)) {
      record = this.load(id);
      if (record.fingerprint !== fingerprint)
        throw new Error("SUBMIT_CONFLICT");
    } else {
      record = {
        version: 1,
        id,
        fingerprint,
        requestId: randomUUID(),
        sessionKey,
        ...(session !== undefined ? { sessionName: session } : {}),
        permissions,
        ...(launch ? { launch } : {}),
        ...(continuationHandle ? { continuationHandle } : {}),
        model, modelConfig, modelProfile,
        cwd,
        prompt,
        callback: selected,
        state: "queued",
        createdAt: this.now(),
      };
      save(filename, record);
    }
    return {
      version: 1,
      task_id: id,
      request_id: record.requestId,
      accepted: true,
    };
  }
  status(id) {
    const record = this.load(id);
    return this.statusRecord(record);
  }
  safeCode(value) { return safeCode(value); }
  statusRecord(record) {
    const result = this.resultRecord(record, { output: false });
    return {
      ...result,
      permission_mode: resultChoice(record.permissions.mode, ["deny-all", "approve-reads", "approve-all"]),
      model: taskModel(record.model).id, variant: identifier(record.model.variant),
      cancel_requested: readJson(this.filename(record.id, "cancel.json"), SNAPSHOT_BYTES, { optional: true }) !== undefined,
      ...(record.deliveryError ? { delivery_error: safeCode(record.deliveryError) } : {}),
      ...(record.executionError ? { execution_error: safeCode(record.executionError) } : {}),
      ...(record.state === "ambiguous"
        ? {
            guidance:
              "原请求结果和副作用未知。recover 只观察原请求或投递已封存通知；独立核实结果，不自动重发。",
          }
        : {}),
    };
  }
  result(id) {
    return this.resultRecord(this.load(id));
  }
  resultRecord(record, { output = true, health = true } = {}) {
    if (record.state == null) throw new Error("INVALID_TASK_RESULT");
    const callback = resultCallback(record);
    const payload = sealedResult(record, callback);
    const session = record.handle ?? {};
    return {
      version: 1,
      task_id: identifier(record.id),
      request_id: identifier(record.requestId),
      session_name: identifier(record.sessionName),
      session_key: identifier(record.sessionKey),
      session_id: identifier(session.backendSessionId),
      acpx_record_id: identifier(session.acpxRecordId),
      state: resultChoice(record.state, [
        "queued", "dispatching", "running", "ambiguous", "outbox", "delivered", "rejected",
      ]),
      result_status: record.notificationKind === "supervision_failure" ? null : payload?.status ?? null,
      callback_status: payload?.status ?? null,
      callback_state: payload ? deliveryState(record) : null,
      callback_kind: payload ? resultChoice(record.notificationKind, ["supervision_failure"]) ?? "request_result" : null,
      health: health ? this.health(record) : null,
      timing: timing(record),
      ...(output ? resultOutput(record, payload, callback) : {}),
      evidence: evidence(record, payload, callback),
    };
  }
  pending(unsupported = []) {
    return fs
      .readdirSync(this.root)
      .filter((id) => taskPattern.test(id))
      .filter(
        (id) => {
          try {
            return fs.existsSync(this.filename(id)) && !["delivered", "rejected"].includes(deliveryState(this.load(id)));
          } catch (error) {
            if (error.message !== "UNSUPPORTED_TASK_RECORD") throw error;
            unsupported.push({ task_id: id, code: error.message });
            return false;
          }
        },
      );
  }
  seal(
    record,
    status,
    output,
    terminalSource = "turn.result",
    outputSource = "assistant_output",
  ) {
    if (record.body) return;
    const body = callbackBody(record.callback, status, output);
    record.resultStatus = status;
    record.terminalAt = this.now();
    record.terminalSource = terminalSource;
    record.outputSource = outputSource;
    const collectedTruncation = outputSource === "assistant_output"
      ? record.outputTruncated ?? false : false;
    record.outputTruncated = body.output !== output ? true : collectedTruncation;
    record.body = JSON.stringify(body);
    record.state = "outbox";
    record.attempts = 0;
    record.nextAttemptAt = this.now();
    delete record.output;
    this.observe(record, "terminal", { assessment: "settled", suspectedAt: undefined, suspectedReason: undefined });
  }
  health(record) {
    const value = record.health ?? {};
    const observed = (name) => {
      const filename = this.filename(record.id, name);
      const sample = readJson(filename, SNAPSHOT_BYTES, { optional: true });
      if (sample === null) throw new Error("INVALID_TASK_RESULT");
      return sample;
    };
    const worker = observed("worker.json");
    const monitor = observed("monitor.json");
    for (const sample of [record.health, worker, monitor]) {
      if (sample != null && (typeof sample !== "object" || Array.isArray(sample))) throw new Error("INVALID_TASK_RESULT");
    }
    if (!record.health && !worker && !monitor) return null;
    return {
      phase: resultChoice(value.phase, ["setup", "setup_failed", "dispatching", "running", "watching", "unknown",
        "recovering", "terminal", "supervision_failed"]),
      observed_at: time(value.observedAt),
      last_event_at: time(value.lastEventAt),
      last_probe_at: time(value.lastProbeAt),
      worker_heartbeat_at: time(worker?.at),
      monitor_heartbeat_at: time(monitor?.at),
      worker_assessment: resultChoice(monitor?.workerAssessment, ["observing", "suspected", "stopping"]),
      worker_suspected_since: time(monitor?.workerSuspectedAt),
      worker_exit_at: time(record.workerExit?.observedAt),
      worker_exit_code: time(record.workerExit?.code),
      retry_not_before: time(value.retryUntil),
      owner: resultChoice(value.owner, ["lease_current", "unavailable", "unknown"]),
      owner_process: resultChoice(value.ownerProcess, ["alive", "gone", "unknown"]),
      owner_heartbeat_at: time(value.ownerHeartbeatAt),
      agent: "unknown",
      progress: resultChoice(value.progress, ["active", "quiet", "tool_running", "provider_retry", "unknown"]),
      journal: resultChoice(value.journal, ["available", "unavailable"]),
      assessment: resultChoice(value.assessment, ["observing", "suspected", "unavailable", "settled"]),
      suspected_since: time(value.suspectedAt),
      suspected_reason: safeCode(value.suspectedReason),
      reason: safeCode(record.executionError),
      outcome: record.notificationKind === "supervision_failure" ? "unknown"
        : resultChoice(record.resultStatus, ["success", "error", "cancelled"]),
      automatic_retry: false,
      policy_ms: value.policy ? Object.fromEntries(Object.keys(HEALTH_DEFAULTS).map((key) => {
        if (value.policy[key] === undefined) return [key, null];
        if (!Number.isSafeInteger(value.policy[key]) || value.policy[key] < 10 || value.policy[key] > 86400000)
          throw new Error("INVALID_TASK_RESULT");
        return [key, value.policy[key]];
      })) : null,
    };
  }
  observe(record, phase, changes = {}) {
    record.health = { ...record.health, phase, observedAt: this.now(), policy: this.policy, ...changes };
    this.heartbeat(phase);
    this.write(record);
  }
  elapsed(wall, tick, clock) {
    if (this.clock && clock === this.clock && Number.isFinite(tick) && tick <= this.tick())
      return this.tick() - tick;
    return Number.isSafeInteger(wall) ? Math.max(0, this.now() - wall) : 0;
  }
  assessment(record, reason, restarted = false) {
    const suspectedAt = reason ? restarted ? this.now() : record.health?.suspectedAt ?? this.now() : undefined;
    return { assessment: reason ? "suspected" : "observing", suspectedAt, suspectedReason: reason };
  }
  fail(record, reason) {
    if (record.body) return;
    record.executionError = reason;
    if (record.state === "queued") {
      this.observe(record, "setup_failed", { assessment: "settled" });
      this.seal(record, "error", `Task did not dispatch a prompt: ${reason}.`,
        "execution_setup_failure", "program_generated");
      return;
    }
    record.state = "ambiguous";
    record.supervisionFailedAt = this.now();
    record.notificationKind = "supervision_failure";
    record.notificationState = "outbox";
    record.outputSource = "program_generated";
    record.terminalSource = "supervision_failure";
    const output = `Original request outcome and side effects are unknown; do not automatically retry. Execution supervision failed: ${reason}. It may still be running. Inspect the original request and verify its result before further action.`;
    const body = callbackBody(record.callback, "error", output);
    record.body = JSON.stringify(body);
    record.outputTruncated = body.output !== output;
    record.attempts = 0;
    record.nextAttemptAt = this.now();
    delete record.output;
    this.observe(record, "supervision_failed", { assessment: "unavailable" });
  }
  finish(record, result, source = "turn.result") {
    const status = terminalStatus(result);
    // failed 可能仅为丢失回复；业务失败须核对原 journal。
    if (status === "error" && (source === "turn.result" || result.error?.detailCode === "WATCH_OUTCOME_UNKNOWN")) {
      record.executionError = result.error?.detailCode === "WATCH_OUTCOME_UNKNOWN"
        ? "REQUEST_OUTCOME_UNKNOWN" : "TURN_FAILED_UNCONFIRMED";
      return false;
    }
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
    if (deliveryState(record) !== "outbox" || record.nextAttemptAt > this.now()) return;
    const state = (value) => {
      if (record.notificationKind === "supervision_failure") record.notificationState = value;
      else record.state = value;
    };
    let retryAfter;
    record.callbackAttemptedAt = this.now();
    this.write(record);
    try {
      const response = await this.fetcher(record.callback.callback_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: record.body,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 202) {
        record.receipt = await receipt(response);
        record.callbackDeliveredAt = this.now();
        state("delivered");
        delete record.deliveryError;
      } else {
        retryAfter = response.headers.get("retry-after");
        await response.body?.cancel();
        if (!(
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500
        )) {
          state("rejected");
          record.deliveryError =
            response.status >= 300 && response.status < 400
              ? "REDIRECT_REFUSED"
              : "CALLBACK_REJECTED";
        }
      }
    } catch {
      record.deliveryError = "DELIVERY_UNCONFIRMED";
    }
    if (deliveryState(record) === "outbox") {
      record.nextAttemptAt =
        this.now() + retryDelay(record.attempts++, retryAfter, this.now());
    }
    this.write(record);
  }
  progress(record, event) {
    const update = event.message?.params?.update ?? (event.type === "tool_call"
      ? { ...event, sessionUpdate: event.tag ?? "tool_call" } : undefined);
    const tools = new Set(record.activeTools ?? []);
    if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate)) {
      if (["pending", "in_progress"].includes(update.status)) tools.add(update.toolCallId);
      if (["completed", "failed"].includes(update.status)) tools.delete(update.toolCallId);
      record.activeTools = [...tools];
    }
    let progress = tools.size ? "tool_running" : "active";
    const retry = update?._meta?.["opencode/retry"];
    let retryUntil = record.health?.retryUntil;
    let retryTick = record.health?.retryTick;
    let retryClock = record.health?.retryClock;
    if (retry === null) retryUntil = retryTick = retryClock = undefined;
    if (retry && Number.isFinite(Date.parse(retry.nextRetryAt))) {
      const until = Date.parse(retry.nextRetryAt);
      if (until !== retryUntil || !this.clock || retryClock !== this.clock || !Number.isFinite(retryTick)) {
        retryTick = this.tick() + until - this.now();
        retryClock = this.clock;
      }
      retryUntil = until;
      progress = "provider_retry";
    }
    record.health = { ...record.health, lastEventAt: this.now(), lastEventTick: this.tick(), eventClock: this.clock,
      eventSequence: (record.health?.eventSequence ?? 0) + 1, progress, retryUntil, retryTick, retryClock };
  }
  async journal(record, signal) {
    while (!signal.aborted && !record.body) {
      try {
        if (!record.handle) {
          const handle = await within(this.runtime.findSession({ sessionKey: record.sessionKey, agent: "opencode", cwd: record.cwd }), this.policy.probeMs);
          if (signal.aborted) return;
          if (!handle) throw new Error("ORIGINAL_SESSION_UNAVAILABLE");
          record.handle = validateHandle(record, handle);
        }
        for await (const event of this.runtime.watchSession({ handle: record.handle, cursor: record.cursor, signal })) {
          if (signal.aborted || record.body) return;
          record.health = { ...record.health, journal: "available" };
          if (event.requestId === record.requestId) {
            record.originalObserved = true;
            const unknown = event.type === "turn_result" && event.result.error?.detailCode === "WATCH_OUTCOME_UNKNOWN";
            if (!unknown) {
              this.progress(record, event);
              const update = event.message?.params?.update;
              if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
                appendOutput(record, update.content.text, update.messageId);
              if (event.type === "turn_result") return event.result;
            }
          }
          record.cursor = event.cursor;
          this.write(record);
        }
      } catch { /* 沿原 cursor 重连。 */ }
      if (signal.aborted || record.body) return;
      record.health = { ...record.health, journal: "unavailable" };
      await delay(this.policy.pollMs);
    }
  }
  async followHealth(record, signal) {
    const began = this.tick();
    let missingSince = began;
    let previousEvent = record.health?.eventSequence;
    // lease 恢复后再配对新进展。
    record.ownerEventSequence ??= previousEvent ?? 0;
    let lastProgress = began - this.elapsed(record.health?.lastEventAt, record.health?.lastEventTick, record.health?.eventClock);
    const waitingSince = began - this.elapsed(record.dispatchedAt, record.dispatchTick, record.dispatchClock);
    let retryUntil;
    let retryTick;
    const confirmation = new Confirmation(this.policy, this.tick);
    while (!signal.aborted) {
      let proof;
      if (record.handle && this.runtime.observeOwner) {
        try {
          proof = await within(this.runtime.observeOwner({ handle: record.handle }), this.policy.probeMs);
        } catch { /* 证据未知。 */ }
      }
      if (signal.aborted) return;
      const at = this.tick();
      const progressed = record.health?.eventSequence !== previousEvent;
      if (progressed) {
        previousEvent = record.health?.eventSequence;
        lastProgress = Number.isFinite(record.health.lastEventTick) ? Math.min(at, record.health.lastEventTick) : at;
      }
      // 只有原请求新进展可为换代配对。
      const ownerCurrent = proof?.owner === "lease_current";
      if (ownerCurrent && (!record.ownerGeneration || (record.health?.eventSequence ?? 0) !== record.ownerEventSequence)) {
        record.ownerGeneration = proof.generation;
        record.ownerEventSequence = record.health?.eventSequence ?? 0;
      }
      const generationChanged = record.ownerGeneration && proof?.generation && record.ownerGeneration !== proof.generation;
      // 重连不刷新静默时间，也不缩短原预算。
      const available = ownerCurrent && !generationChanged && record.originalObserved;
      if (progressed || available) missingSince = at;
      const healthyWait = ownerCurrent && !generationChanged && !record.originalObserved;
      let reason;
      if (!healthyWait && at - missingSince >= this.policy.discoveryMs) {
        reason = !record.handle ? "ORIGINAL_SESSION_UNAVAILABLE" : generationChanged ? "OWNER_CHANGED"
          : record.health?.journal === "unavailable" ? "JOURNAL_UNAVAILABLE" : "OWNER_UNAVAILABLE";
      }
      const health = record.health ?? {};
      if (health.retryUntil !== retryUntil) {
        retryUntil = health.retryUntil;
        // 过期 retry 不再获宽限。
        retryTick = this.clock && health.retryClock === this.clock && Number.isFinite(health.retryTick)
          ? health.retryTick : Number.isFinite(retryUntil) ? at + retryUntil - this.now() : undefined;
      }
      const retryWaiting = Number.isFinite(retryTick) && at < retryTick + this.policy.progressMs;
      const quietLimit = record.activeTools?.length ? this.policy.toolMs : this.policy.progressMs;
      if (record.originalObserved && at - lastProgress >= quietLimit && !retryWaiting)
        reason ??= health.journal === "unavailable" ? "JOURNAL_UNAVAILABLE" : "PROGRESS_UNCONFIRMED";
      if (healthyWait && at - waitingSince >= this.policy.progressMs) reason = "REQUEST_UNOBSERVABLE";
      if (progressed) reason = undefined;
      const previousSuspicion = confirmation.since;
      const confirmed = confirmation.update(reason);
      if (!reason && record.executionError !== "REQUEST_FAILED") delete record.executionError;
      this.observe(record, record.health?.phase ?? "watching", {
        lastProbeAt: this.now(), owner: proof?.owner ?? "unavailable",
        ownerProcess: proof?.process ?? "unknown", ownerHeartbeatAt: proof?.heartbeatAt,
        ...this.assessment(record, reason, previousSuspicion !== confirmation.since),
      });
      if (confirmed) {
        // 先处理已就绪终态。
        await delay(0);
        if (signal.aborted) return;
        if (record.health?.eventSequence !== previousEvent) continue;
        return reason;
      }
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, this.policy.pollMs);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  async watch(record) {
    const controller = new AbortController();
    const monitor = this.monitorCancellation(record, () =>
      this.runtime.cancelRequest?.({
        handle: record.handle,
        requestId: record.requestId,
      }),
    );
    if (!record.cursor) {
      record.output = "";
      record.outputTruncated = false;
      delete record.outputMessageId;
    }
    this.observe(record, "watching");
    try {
      const outcome = await Promise.race([
        this.journal(record, controller.signal).then((result) => ({ result })),
        this.followHealth(record, controller.signal).then((reason) => ({ reason })),
      ]);
      if (outcome.result) this.finish(record, outcome.result, "watchSession.turn_result");
      else if (outcome.reason) record.executionError = outcome.reason;
    } catch {
      record.executionError = "JOURNAL_UNAVAILABLE";
    } finally {
      controller.abort();
      clearInterval(monitor);
    }
    if (!record.body) {
      record.state = "ambiguous";
      record.executionError ??= "REQUEST_UNOBSERVABLE";
      this.observe(record, "unknown", { assessment: "unavailable" });
    }
  }
  monitorCancellation(record, cancel) {
    let pending = false;
    const monitor = setInterval(() => {
      if (!pending && fs.existsSync(this.filename(record.id, "cancel.json"))) {
        pending = true;
        Promise.resolve()
          .then(cancel)
          .catch(() => {}).finally(() => { pending = false; });
      }
    }, 200);
    monitor.unref();
    return monitor;
  }
  async setupSession(record) {
    const pending = this.runtime.ensureSession({ sessionKey: record.sessionKey, agent: "opencode",
      mode: "persistent", cwd: record.cwd, model: record.model });
    try {
      return await within(pending, this.policy.setupMs);
    } catch (error) {
      if (error.message !== "OBSERVATION_TIMEOUT") throw error;
      this.observe(record, "setup", { assessment: "suspected", suspectedAt: this.now(), suspectedReason: "SETUP_SLOW" });
      return await within(pending, this.policy.confirmMs); // 等同一个初始化，不再发一次 ensureSession。
    }
  }
  async execute(id, { observeOnly = false } = {}) {
    const record = this.load(id);
    if (record.body) return;
    if (record.state === "queued") {
      if (fs.existsSync(this.filename(id, "cancel.json"))) {
        this.seal(
          record,
          "cancelled",
          "Task cancelled before execution.",
          "queued_cancellation",
          "program_generated",
        );
        return;
      }
      if (observeOnly) {
        this.fail(record, "WORKER_LOST_BEFORE_DISPATCH");
        return;
      }
      record.workerAttemptedAt ??= this.now();
      this.observe(record, "setup", { assessment: "observing" });
      try {
        record.handle = validateHandle(
          record,
          await this.setupSession(record),
        );
        delete record.executionError;
      } catch {
        this.fail(record, "MODEL_OR_SESSION_SETUP_FAILED");
        return;
      }
      record.state = "dispatching";
      record.dispatchedAt = this.now();
      record.dispatchTick = this.tick();
      record.dispatchClock = this.clock;
      record.outputTruncated = false;
      this.observe(record, "dispatching", { assessment: "observing", suspectedAt: undefined, suspectedReason: undefined });
      let monitor;
      let active = true;
      let healthConfirmed = false;
      const controller = new AbortController();
      try {
        const turn = this.runtime.startTurn({
          handle: record.handle,
          text: record.prompt,
          mode: "prompt",
          requestId: record.requestId,
        });
        const resultPromise = Promise.resolve(turn.result);
        const streamOutput = {};
        Promise.resolve(turn.promptStarted)
          .then(() => {
            if (!active || record.body) return;
            record.state = "running";
            record.originalObserved = true;
            this.progress(record, { type: "prompt_started" });
            if (record.startedAt === undefined) record.startedAt = this.now();
            this.observe(record, "running");
          })
          .catch(() => {});
        const cancel = () => this.runtime.cancelRequest({ handle: record.handle, requestId: record.requestId });
        monitor = this.monitorCancellation(record, cancel);
        if (fs.existsSync(this.filename(id, "cancel.json")))
          Promise.resolve(cancel()).catch(() => {});
        const consume = (async () => {
          for await (const event of turn.events) {
            if (!active || record.body) break;
            // 工具事件可能先于 journal，仍计为进展。
            record.originalObserved = true;
            this.progress(record, event);
            if (event.type === "text_delta" && event.stream !== "thought")
              appendOutput(streamOutput, event.text, event.messageId);
          }
        })().catch(() => {});
        const journal = this.journal(record, controller.signal)
          .then((result) => result ? { result, source: "watchSession.turn_result" } : new Promise(() => {}))
          .catch(() => new Promise(() => {}));
        const { result, source, reason } = await Promise.race([
          resultPromise.then((result) => ({ result, source: "turn.result" })),
          journal,
          this.followHealth(record, controller.signal).then((reason) => ({ reason })),
        ]);
        if (reason) {
          healthConfirmed = true;
          record.state = "ambiguous";
          record.executionError = reason;
          this.observe(record, "unknown", { assessment: "unavailable" });
        } else {
          // 不让输出迭代器或 promptStarted 阻止终态。
          await within(consume, this.policy.drainMs).catch(() => {});
          if (source === "turn.result") {
            await within(journal, this.policy.drainMs).catch(() => {});
            if (streamOutput.output !== undefined) {
              record.output = streamOutput.output;
              record.outputTruncated = streamOutput.outputTruncated ?? false;
            }
          }
          this.finish(record, result, source);
        }
      } catch (error) {
        record.state = "ambiguous";
        record.executionError = ["REQUEST_UNOBSERVABLE", "OWNER_UNAVAILABLE", "AGENT_DISCONNECTED", "PROGRESS_UNCONFIRMED"].includes(error.message)
          ? error.message : "TURN_TRANSPORT_INTERRUPTED";
        this.observe(record, "recovering");
      } finally {
        active = false;
        controller.abort();
        clearInterval(monitor);
      }
      if (!record.body && !healthConfirmed) await this.watch(record);
    } else if (["dispatching", "running", "ambiguous"].includes(record.state)) {
      if (record.handle) validateHandle(record, record.handle);
      await this.watch(record);
    }
  }
  async cancel(id) {
    const record = this.load(id);
    if (record.body && record.notificationKind !== "supervision_failure") throw new Error("TASK_TERMINAL");
    save(this.filename(id, "cancel.json"), { requested: true });
    if (record.handle) {
      validateHandle(record, record.handle);
      await within(Promise.resolve(this.runtime.cancelRequest?.({
        handle: record.handle,
        requestId: record.requestId,
      })), this.policy.probeMs);
    }
  }
}

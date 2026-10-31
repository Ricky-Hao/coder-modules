/** Module-owned task records and outbox. No callback data enters ACP. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const OUTPUT_BYTES = 32768;
export const HEALTH_DEFAULTS = Object.freeze({
  pollMs: 5000,
  probeMs: 3000,
  discoveryMs: 30000,
  setupMs: 30000,
  workerMs: 30000,
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

function read(filename) {
  return JSON.parse(fs.readFileSync(privateFile(filename), "utf8"));
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
  if (model === undefined) return undefined; // Pre-selection records retain their original shape.
  if (
    !model || typeof model.id !== "string" || model.id.length > 256 ||
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
  const truncated = typeof record.outputTruncated === "boolean"
    ? record.outputTruncated : null;
  // Inspect the sealed text before clipping, so a clipped bearer is not printable.
  const privateOutput = privateResultText(payload.output, callback);
  return {
    output: privateOutput ? null : boundedOutput.text,
    output_bytes: privateOutput ? null : boundedOutput.bytes,
    output_limit_bytes: limit,
    output_truncated: boundedOutput.truncated ? true : truncated,
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
      "turn.result", "watchSession.turn_result", "queued_cancellation", "operator_resolution",
      "execution_setup_failure", "supervision_failure",
    ]) : null,
    output_source: payload ? resultChoice(record.outputSource, [
      "assistant_output", "program_generated", "operator_verified",
    ]) : null,
    callback_receipt: resultReceipt(record.receipt, callback),
  };
}

/** Keep the last assistant message, including bounded chunks; thoughts/tools are omitted. */
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
  if (
    result.status === "cancelled" ||
    result.error?.code === "QUEUE_REQUEST_CANCELLED" ||
    result.error?.detailCode === "QUEUE_REQUEST_CANCELLED"
  )
    return "cancelled";
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
  constructor({ root, runtime, fetcher = fetch, now = Date.now, policy = HEALTH_DEFAULTS, heartbeat = () => {} }) {
    this.root = directory(root);
    this.runtime = runtime;
    this.fetcher = fetcher;
    this.now = now;
    this.policy = policy;
    this.heartbeat = heartbeat;
  }
  filename(id, name = "task.json") {
    if (!taskPattern.test(id)) throw new Error("INVALID_TASK_ID");
    return path.join(directory(path.join(this.root, id)), name);
  }
  load(id) {
    return read(this.filename(id));
  }
  write(record) {
    save(this.filename(record.id), record);
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
    modelProfile = "external",
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
    if (model && (typeof modelConfig !== "string" || !path.isAbsolute(modelConfig)))
      throw new Error("TASK_MODEL_CONFIG_REQUIRED");
    if (model && !["env", "external"].includes(modelProfile))
      throw new Error("INVALID_MODEL_PROFILE");
    if (
      session !== undefined &&
      (typeof session !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session))
    )
      throw new Error("INVALID_SESSION");
    const selected = validateCallback(callback);
    // Callback bytes cannot accidentally be copied from registration into the executor prompt.
    if (
      prompt.includes(selected.callback_id) ||
      prompt.includes(selected.callback_url)
    )
      throw new Error("CALLBACK_IN_PROMPT");
    const id = `task_${hash(key)}`;
    let sessionKey = id;
    if (session !== undefined) {
      const sessions = path.join(this.root, ".sessions");
      try {
        fs.mkdirSync(sessions, { mode: 0o700 });
        save(path.join(sessions, "owner.json"), {
          schema: 1,
          uid: process.getuid(),
        });
        syncDirectory(this.root);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      directory(sessions);
      if (
        JSON.stringify(read(path.join(sessions, "owner.json"))) !==
        JSON.stringify({ schema: 1, uid: process.getuid() })
      )
        throw new Error("INVALID_SESSION_OWNER");
      const binding = path.join(sessions, `${hash(session)}.json`);
      sessionKey = `module-task-session_${hash(JSON.stringify([cwd, session]))}`;
      if (fs.existsSync(binding)) {
        const prior = read(binding);
        if (
          prior.cwd !== cwd ||
          prior.name !== session ||
          prior.sessionKey !== sessionKey
        )
          throw new Error("SESSION_CWD_CONFLICT");
        if (JSON.stringify(prior.model) !== JSON.stringify(model) || prior.modelConfig !== modelConfig ||
            model && prior.modelProfile !== modelProfile)
          throw new Error("SESSION_MODEL_CONFLICT");
      } else save(binding, {
        version: 1, name: session, cwd, sessionKey,
        ...(model ? { model, modelConfig, modelProfile } : {}),
      });
    }
    const fingerprint = hash(
      JSON.stringify({
        prompt,
        cwd,
        callback: selected,
        sessionKey,
        permissions,
        ...(model ? { model, modelConfig, modelProfile } : {}),
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
      record = read(filename);
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
        ...(model ? { model, modelConfig, modelProfile } : {}),
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
    return {
      version: 1,
      task_id: id,
      request_id: record.requestId,
      state: record.state,
      permission_mode: record.permissions?.mode ?? "deny-all",
      ...(record.model ? { model: record.model.id, variant: record.model.variant ?? null } : {}),
      ...(record.sessionName ? { session: record.sessionName } : {}),
      cancel_requested: fs.existsSync(this.filename(id, "cancel.json")),
      ...(record.notificationKind === "supervision_failure" ? { result_status: null }
        : record.resultStatus ? { result_status: record.resultStatus } : {}),
      ...(record.deliveryError ? { delivery_error: record.deliveryError } : {}),
      ...(record.executionError ? { execution_error: record.executionError } : {}),
      timing: timing(record),
      health: this.health(record),
      callback_state: record.body ? deliveryState(record) : null,
      callback_kind: record.body ? resultChoice(record.notificationKind, ["supervision_failure"]) ?? "request_result" : null,
      callback_status: record.body ? record.notificationKind === "supervision_failure" ? "error" : record.resultStatus ?? null : null,
      ...(record.state === "ambiguous"
        ? {
            guidance:
              record.body
                ? "Original outcome and side effects are unknown. The supervision notification is sealed; independently verify the original request. Never automatically resubmit the prompt."
                : "Original request outcome is unknown. Recover watches that request; resolve only with independently verified output. Never automatically resubmit the prompt.",
          }
        : {}),
    };
  }
  result(id) {
    let record;
    try {
      record = this.load(id);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("INVALID_TASK_RESULT");
      throw error;
    }
    if (!record || record.version !== 1 || record.id !== id)
      throw new Error("INVALID_TASK_RESULT");
    const callback = resultCallback(record);
    const payload = sealedResult(record, callback);
    const session = record.handle ?? {};
    return {
      version: 1,
      task_id: id,
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
      health: this.health(record),
      timing: timing(record),
      ...resultOutput(record, payload, callback),
      evidence: evidence(record, payload, callback),
    };
  }
  pending() {
    return fs
      .readdirSync(this.root)
      .filter((id) => taskPattern.test(id))
      .filter(
        (id) =>
          fs.existsSync(this.filename(id)) &&
           !["delivered", "rejected"].includes(deliveryState(this.load(id))),
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
      ? record.outputTruncated ?? null : false;
    record.outputTruncated = body.output !== output ? true : collectedTruncation;
    record.body = JSON.stringify(body);
    record.state = "outbox";
    record.attempts = 0;
    record.nextAttemptAt = this.now();
    delete record.output;
    // The exact result/body is fsync'd before even the first HTTP attempt.
    this.observe(record, "terminal");
  }
  health(record) {
    const value = record.health;
    if (!value) return null;
    const observed = (name) => {
      const filename = this.filename(record.id, name);
      return fs.existsSync(filename) ? time(read(filename).at) : null;
    };
    return {
      phase: identifier(value.phase),
      observed_at: time(value.observedAt),
      last_event_at: time(value.lastEventAt),
      last_probe_at: time(value.lastProbeAt),
      worker_heartbeat_at: observed("worker.json"),
      monitor_heartbeat_at: observed("monitor.json"),
      worker_exit_at: time(record.workerExit?.observedAt),
      worker_exit_code: time(record.workerExit?.code),
      retry_not_before: time(value.retryUntil),
      owner: resultChoice(value.owner, ["lease_current", "unavailable", "unknown"]),
      owner_process: resultChoice(value.ownerProcess, ["alive", "gone", "unknown"]),
      owner_heartbeat_at: time(value.ownerHeartbeatAt),
      agent: "unknown", // Shared acpx exposes no agent process exit/heartbeat witness.
      progress: resultChoice(value.progress, ["active", "quiet", "tool_running", "provider_retry", "unknown"]),
      reason: identifier(record.executionError),
      outcome: record.notificationKind === "supervision_failure" ? "unknown"
        : resultChoice(record.resultStatus, ["success", "error", "cancelled"]),
      automatic_retry: false,
      policy_ms: value.policy ? Object.fromEntries(Object.keys(HEALTH_DEFAULTS).map((key) => {
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
  fail(record, reason) {
    if (record.body) return;
    record.executionError = reason;
    if (record.state === "queued") {
      this.observe(record, "setup_failed");
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
    this.observe(record, "supervision_failed");
  }
  finish(record, result, source = "turn.result") {
    const status = terminalStatus(result);
    // Shared result.failed also represents lost ACK/completion replies. A matching
    // journal terminal confirms failure; WATCH_OUTCOME_UNKNOWN confirms only loss.
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
    if (retry === null) retryUntil = undefined;
    if (retry && Number.isFinite(Date.parse(retry.nextRetryAt))) {
      retryUntil = Date.parse(retry.nextRetryAt);
      progress = "provider_retry";
    }
    record.health = { ...record.health, lastEventAt: this.now(), progress, retryUntil };
  }
  async journal(record, signal, { collect = true, checkpoint = true } = {}) {
    for await (const event of this.runtime.watchSession({ handle: record.handle, cursor: record.cursor, signal })) {
      if (signal.aborted || record.body) return;
      if (event.requestId === record.requestId) {
        record.originalObserved = true;
        this.progress(record, event);
        const update = event.message?.params?.update;
        if (collect && update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
          appendOutput(record, update.content.text, update.messageId);
        if (event.type === "turn_result") return event.result;
      }
      if (checkpoint) {
        record.cursor = event.cursor;
        this.write(record);
      }
    }
  }
  async followHealth(record, signal, { maxMs = Infinity } = {}) {
    const began = performance.now();
    let missingSince = began;
    let previousEvent = record.health?.lastEventAt;
    // Carry the persisted quiet interval across restarts, then use a monotonic clock.
    let lastProgress = began - (Number.isSafeInteger(previousEvent)
      ? Math.max(0, this.now() - previousEvent) : 0);
    let reason = "REQUEST_UNOBSERVABLE";
    while (!signal.aborted) {
      if (this.runtime.observeOwner) {
        let proof;
        try {
          proof = await within(this.runtime.observeOwner({ handle: record.handle }), this.policy.probeMs);
        } catch { /* A failed probe is availability evidence, never a business result. */ }
        if (signal.aborted) return;
        // Progress may arrive while the asynchronous process probe is pending.
        if (record.health?.lastEventAt !== previousEvent) {
          previousEvent = record.health?.lastEventAt;
          lastProgress = performance.now();
        }
        const generationChanged = record.ownerGeneration && proof?.generation && record.ownerGeneration !== proof.generation;
        if (!record.ownerGeneration && proof?.generation) record.ownerGeneration = proof.generation;
        const available = proof?.owner === "lease_current" && !generationChanged && record.originalObserved;
        if (available) missingSince = performance.now();
        reason = generationChanged ? "OWNER_CHANGED" : proof?.owner !== "lease_current" ? "OWNER_UNAVAILABLE" : "REQUEST_UNOBSERVABLE";
        let progress = record.health?.progress ?? "unknown";
        const retryWaiting = record.health?.retryUntil > this.now() - this.policy.progressMs;
        const quietLimit = progress === "tool_running" ? this.policy.toolMs : this.policy.progressMs;
        const quiet = record.originalObserved && performance.now() - lastProgress >= quietLimit && !retryWaiting;
        if (quiet) progress = "quiet";
        this.observe(record, record.health?.phase ?? "watching", {
          lastProbeAt: this.now(), owner: proof?.owner ?? "unavailable",
          ownerProcess: proof?.process ?? "unknown", ownerHeartbeatAt: proof?.heartbeatAt, progress,
        });
        if (quiet) return "PROGRESS_UNCONFIRMED";
      }
      if (performance.now() - began >= maxMs) return reason;
      if (performance.now() - missingSince >= this.policy.discoveryMs) return reason;
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, this.policy.pollMs);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  async watch(record, maxMs = Infinity) {
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
        this.followHealth(record, controller.signal, { maxMs }).then((reason) => ({ reason })),
      ]);
      if (outcome.result) this.finish(record, outcome.result, "watchSession.turn_result");
      else if (outcome.reason) record.executionError = outcome.reason;
    } catch {
      record.executionError = "JOURNAL_UNAVAILABLE";
      /* Journal/owner uncertainty never authorizes prompt replay. */
    } finally {
      controller.abort();
      clearInterval(monitor);
    }
    if (!record.body) {
      record.state = "ambiguous";
      record.executionError ??= "REQUEST_UNOBSERVABLE";
      this.observe(record, "unknown");
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
      // Persist the attempt while holding worker.lock, before setup or dispatch.
      record.workerAttemptedAt ??= this.now();
      this.observe(record, "setup");
      try {
        record.handle = validateHandle(
          record,
          await within(this.runtime.ensureSession({
            sessionKey: record.sessionKey,
            agent: "opencode",
            mode: "persistent",
            cwd: record.cwd,
            ...(record.model ? { model: record.model } : {}),
          }), this.policy.setupMs),
        );
        delete record.executionError;
      } catch {
        this.fail(record, "MODEL_OR_SESSION_SETUP_FAILED");
        return;
      }
      record.state = "dispatching";
      record.outputTruncated = false;
      this.observe(record, "dispatching");
      let monitor;
      let active = true;
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
        const cancel = () => this.runtime.cancelRequest
          ? this.runtime.cancelRequest({ handle: record.handle, requestId: record.requestId }) : turn.cancel();
        monitor = this.monitorCancellation(record, cancel);
        if (fs.existsSync(this.filename(id, "cancel.json")))
          Promise.resolve(cancel()).catch(() => {});
        const consume = (async () => {
          for await (const event of turn.events) {
            if (!active || record.body) break;
            // Live tool updates precede the journal's checkpoint. Keep their
            // liveness evidence even when raw journal metadata supplies retries.
            this.progress(record, event);
            if (event.type === "text_delta" && event.stream !== "thought")
              appendOutput(this.runtime.journalAuthoritative ? streamOutput : record, event.text, event.messageId);
          }
        })().catch(() => {});
        const journal = this.journal(record, controller.signal, {
          collect: Boolean(this.runtime.journalAuthoritative),
          checkpoint: Boolean(this.runtime.journalAuthoritative),
        }).then((result) => result ? { result, source: "watchSession.turn_result" } : new Promise(() => {}))
          .catch(() => new Promise(() => {}));
        const { result, source } = await Promise.race([
          resultPromise.then((result) => ({ result, source: "turn.result" })),
          journal,
          this.followHealth(record, controller.signal).then((reason) => { throw new Error(reason); }),
        ]);
        // Result is authoritative. Give already-buffered output a bounded drain;
        // neither a stuck events iterator nor promptStarted can veto completion.
        await within(consume, this.policy.drainMs).catch(() => {});
        if (this.runtime.journalAuthoritative && source === "turn.result") {
          await within(journal, this.policy.drainMs).catch(() => {});
          if (streamOutput.output !== undefined) {
            record.output = streamOutput.output;
            record.outputTruncated = streamOutput.outputTruncated ?? false;
          }
        }
        this.finish(record, result, source);
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
      if (!record.body) await this.watch(record, this.policy.discoveryMs);
    } else if (["dispatching", "running", "ambiguous"].includes(record.state)) {
      if (!record.handle)
        record.handle = await within(this.runtime.findSession({
          sessionKey: record.sessionKey,
          agent: "opencode",
          cwd: record.cwd,
        }), this.policy.probeMs).catch(() => null);
      if (record.handle) {
        validateHandle(record, record.handle);
        await this.watch(record);
      } else {
        this.fail(record, "ORIGINAL_SESSION_UNAVAILABLE");
      }
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
  resolve(id, status, output) {
    const record = this.load(id);
    if (record.state !== "ambiguous" || record.body)
      throw new Error("TASK_NOT_AMBIGUOUS");
    this.seal(
      record,
      status,
      output,
      "operator_resolution",
      "operator_verified",
    );
  }
}

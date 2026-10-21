/** Module-owned task records and outbox. No callback data enters ACP. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const OUTPUT_BYTES = 32768;
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

/** Keep the last assistant message, including bounded chunks; thoughts/tools are omitted. */
export function appendOutput(record, text, messageId) {
  if (messageId && messageId !== record.outputMessageId) {
    record.outputMessageId = messageId;
    record.output = "";
  }
  record.output = bounded((record.output ?? "") + text);
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
  constructor({ root, runtime, fetcher = fetch, now = Date.now }) {
    this.root = directory(root);
    this.runtime = runtime;
    this.fetcher = fetcher;
    this.now = now;
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
      } else save(binding, { version: 1, name: session, cwd, sessionKey });
    }
    const fingerprint = hash(
      JSON.stringify({
        prompt,
        cwd,
        callback: selected,
        sessionKey,
        permissions,
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
      ...(record.sessionName ? { session: record.sessionName } : {}),
      cancel_requested: fs.existsSync(this.filename(id, "cancel.json")),
      ...(record.resultStatus ? { result_status: record.resultStatus } : {}),
      ...(record.deliveryError ? { delivery_error: record.deliveryError } : {}),
      ...(record.state === "ambiguous"
        ? {
            guidance:
              "Original request outcome is unknown. Recover watches that request; resolve only with independently verified output. Never automatically resubmit the prompt.",
          }
        : {}),
    };
  }
  pending() {
    return fs
      .readdirSync(this.root)
      .filter((id) => taskPattern.test(id))
      .filter(
        (id) =>
          fs.existsSync(this.filename(id)) &&
          !["delivered", "rejected"].includes(this.load(id).state),
      );
  }
  seal(record, status, output) {
    if (record.body) return;
    record.resultStatus = status;
    record.body = JSON.stringify(callbackBody(record.callback, status, output));
    record.state = "outbox";
    record.attempts = 0;
    record.nextAttemptAt = this.now();
    delete record.output;
    // The exact result/body is fsync'd before even the first HTTP attempt.
    this.write(record);
  }
  async deliver(record) {
    if (record.state !== "outbox" || record.nextAttemptAt > this.now()) return;
    let retryAfter;
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
        record.state = "delivered";
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
          record.state = "rejected";
          record.deliveryError =
            response.status >= 300 && response.status < 400
              ? "REDIRECT_REFUSED"
              : "CALLBACK_REJECTED";
        }
      }
    } catch {
      record.deliveryError = "DELIVERY_UNCONFIRMED";
    }
    if (record.state === "outbox") {
      record.nextAttemptAt =
        this.now() + retryDelay(record.attempts++, retryAfter, this.now());
    }
    this.write(record);
  }
  async watch(record, timeoutMs = 30000) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    deadline.unref();
    const monitor = this.monitorCancellation(record, () =>
      this.runtime.cancelRequest?.({
        handle: record.handle,
        requestId: record.requestId,
      }),
    );
    if (!record.cursor) {
      record.output = "";
      delete record.outputMessageId;
    }
    try {
      for await (const event of this.runtime.watchSession({
        handle: record.handle,
        cursor: record.cursor,
        signal: controller.signal,
      })) {
        // A persistent owner may have other requests. Their results never settle this task.
        if (event.requestId === record.requestId) {
          // Once this original request is observed, follow its journal for as
          // long as it runs. Owner uncertainty, not elapsed runtime, ends recovery.
          clearTimeout(deadline);
          if (event.type === "message") {
            const update = event.message?.params?.update;
            if (
              update?.sessionUpdate === "agent_message_chunk" &&
              update.content?.type === "text"
            )
              appendOutput(record, update.content.text, update.messageId);
          }
          if (event.type === "turn_result") {
            this.seal(
              record,
              terminalStatus(event.result),
              record.output ?? "",
            );
            return;
          }
        }
        record.cursor = event.cursor;
        this.write(record);
      }
    } catch {
      /* Journal/owner uncertainty never authorizes prompt replay. */
    } finally {
      clearTimeout(deadline);
      clearInterval(monitor);
    }
    record.state = "ambiguous";
    this.write(record);
  }
  monitorCancellation(record, cancel) {
    const monitor = setInterval(() => {
      if (fs.existsSync(this.filename(record.id, "cancel.json")))
        Promise.resolve()
          .then(cancel)
          .catch(() => {});
    }, 200);
    monitor.unref();
    return monitor;
  }
  async execute(id) {
    const record = this.load(id);
    if (record.state === "queued") {
      if (fs.existsSync(this.filename(id, "cancel.json"))) {
        this.seal(record, "cancelled", "Task cancelled before execution.");
        return;
      }
      // ensureSession does not dispatch the prompt. A queued crash is safe to resume.
      record.handle = validateHandle(
        record,
        await this.runtime.ensureSession({
          sessionKey: record.sessionKey,
          agent: "opencode",
          mode: "persistent",
          cwd: record.cwd,
        }),
      );
      record.state = "dispatching";
      this.write(record);
      let monitor;
      try {
        const turn = this.runtime.startTurn({
          handle: record.handle,
          text: record.prompt,
          mode: "prompt",
          requestId: record.requestId,
        });
        const resultPromise = turn.result;
        const started = turn.promptStarted
          .then(() => {
            record.state = "running";
            this.write(record);
          })
          .catch(() => {});
        monitor = this.monitorCancellation(record, () => turn.cancel());
        if (fs.existsSync(this.filename(id, "cancel.json")))
          await turn.cancel();
        const consume = (async () => {
          for await (const event of turn.events) {
            if (event.type === "text_delta" && event.stream !== "thought")
              appendOutput(record, event.text, event.messageId);
          }
        })();
        const [result] = await Promise.all([resultPromise, consume, started]);
        this.seal(record, terminalStatus(result), record.output ?? "");
      } catch {
        record.state = "ambiguous";
        this.write(record);
      } finally {
        clearInterval(monitor);
      }
    } else if (["dispatching", "running", "ambiguous"].includes(record.state)) {
      if (!record.handle)
        record.handle = await this.runtime.findSession({
          sessionKey: record.sessionKey,
          agent: "opencode",
          cwd: record.cwd,
        });
      if (record.handle) {
        validateHandle(record, record.handle);
        await this.watch(record);
      } else {
        record.state = "ambiguous";
        this.write(record);
      }
    }
  }
  async cancel(id) {
    const record = this.load(id);
    if (record.body) throw new Error("TASK_TERMINAL");
    save(this.filename(id, "cancel.json"), { requested: true });
    if (record.handle) {
      validateHandle(record, record.handle);
      await this.runtime.cancelRequest?.({
        handle: record.handle,
        requestId: record.requestId,
      });
    }
  }
  resolve(id, status, output) {
    const record = this.load(id);
    if (record.state !== "ambiguous" || record.body)
      throw new Error("TASK_NOT_AMBIGUOUS");
    this.seal(record, status, output);
  }
}

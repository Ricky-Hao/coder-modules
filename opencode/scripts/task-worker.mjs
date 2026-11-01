/** 一个持 control.lock 的 worker：一次派发、journal 观察、持久 outbox。 */
import fs from "node:fs";
import { callback, bounded, delay, diagnostic, runtimeError, save, TaskError, within } from "./task.mjs";

export function retryDelay(attempt, retryAfter, now) {
  const supplied = /^\d+$/.test(retryAfter ?? "") ? Number(retryAfter) * 1000 : Date.parse(retryAfter ?? "") - now;
  return Math.min(86400000, Math.max(Math.min(300000, 5000 * 2 ** Math.min(attempt, 10)), Number.isFinite(supplied) ? supplied : 0));
}
async function receipt(response) {
  const fail = () => new TaskError("INVALID_RECEIPT", { stage: "outbox", field: "receipt" });
  if (!response.body) throw fail();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length; if (size > 4096) throw fail(); chunks.push(item.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value.version !== 1 || typeof value.receipt_id !== "string" || !value.receipt_id || value.receipt_id.length > 256 ||
        typeof value.accepted_at !== "string" || value.accepted_at.length > 256 || !Number.isFinite(Date.parse(value.accepted_at)) ||
        /tcb_|:\/\//.test(value.receipt_id + value.accepted_at)) throw fail();
    return { receipt_id: value.receipt_id, accepted_at: value.accepted_at };
  } catch { throw fail(); } finally { await reader.cancel().catch(() => {}); }
}
export class TaskWorker {
  constructor(store, { connect, runtime, fetcher = fetch, pollMs = 200, ioMs = 3000 } = {}) {
    this.store = store; this.connect = connect ?? (() => runtime); this.fetcher = fetcher;
    this.pollMs = pollMs; this.ioMs = ioMs;
  }
  write() { this.store.write(this.task); this.dirty = false; }
  progress() {
    this.timeout();
    this.task.progress = this.store.stamp(); this.dirty = true;
  }
  observation(error, field = "request") {
    this.task.observationError = diagnostic(runtimeError(error, "observe", field, "REQUEST_OUTCOME_UNKNOWN")); this.dirty = true;
  }
  input() { return this.privateInput ??= this.store.input(this.task); }
  seal(status, text, kind) {
    if (this.box) return;
    const target = callback(this.input().callback);
    if (text.includes("tcb_") || text.includes(target.url)) text = "Output withheld: private callback content.";
    this.box = { url: target.url, body: JSON.stringify({ version: 1, callback_id: target.id, status, output: bounded(text, target.max) }),
      kind, state: "pending", attempts: 0, nextAttemptAt: this.store.now() };
    save(this.store.filename(this.task.id, "outbox.json"), this.box);
  }
  finish(result, source, outputComplete = false) {
    const task = this.task;
    try { if (task.dispatchedAt) this.timeout(); }
    finally {
      if (!task.result) {
        const status = result.status === "completed" ? "success" : result.status === "cancelled" ? "cancelled" : "error";
        task.result = { status, source, at: this.store.now(), outputComplete };
        task.phase = "finished";
        if (status === "error" && !task.error) task.error = diagnostic(runtimeError(result.error, "result", "request", "REQUEST_FAILED"));
        this.terminalDeadline = this.store.now() + this.ioMs;
      } else if (outputComplete) task.result.outputComplete = true;
      this.write(); // 通知或 journal 失败也保留可信终态。
    }
  }
  beforeDispatch(code, cancelled = false) {
    if (cancelled) delete this.task.error;
    else this.task.error ??= diagnostic(new TaskError(code, { stage: "setup", field: "request" }));
    this.task.output = { text: cancelled ? "Task cancelled before dispatch." : `Task did not dispatch: ${code}.`, truncated: false };
    this.finish({ status: cancelled ? "cancelled" : "failed" }, "before_dispatch", true);
  }
  timeout() {
    if (this.task.result || this.box || this.store.remaining(this.task) > 0) return;
    if (!this.task.dispatchedAt) this.beforeDispatch("NO_PROGRESS");
    else this.seal("error", "Original request outcome and side effects are unknown. No original execution progress within the configured timeout. Observe the original request; do not replay or automatically cancel.", "no_progress");
  }
  cancelRequested() { return fs.existsSync(this.store.filename(this.task.id, "cancel.request")); }
  async start() {
    const task = this.task;
    try {
      const input = this.input();
      this.runtime = await this.connect(task);
      const handle = await this.runtime.ensureSession({ sessionKey: task.sessionKey, agent: "opencode", mode: "persistent", cwd: task.cwd });
      if (!this.alive || task.result) return;
      task.handle = handle;
      if (this.cancelRequested()) { this.beforeDispatch("CANCELLED", true); return; }
      if (this.store.remaining(task) <= 0) { this.timeout(); return; }
      task.phase = "dispatched"; task.dispatchedAt = this.store.now(); this.write();
      let turn;
      try { turn = this.runtime.startTurn({ handle, text: input.prompt, mode: "prompt", requestId: task.requestId }); }
      catch (error) { this.observation(error); return; }
      // 固定 acpx 的本地队列无上限；关闭旁路，仅 journal 聚合文本。
      turn.closeStream().catch((error) => { if (this.alive) this.observation(error); });
      turn.promptStarted.then(() => {
        if (this.alive && !task.result) { task.startedAt ??= this.store.now(); this.progress(); }
      }, (error) => { if (this.alive && !task.result) this.observation(error); }).catch((error) => { this.failure = error; });
      turn.result.then((result) => {
        if (!this.alive || task.result) return;
        if (result.status === "failed") this.observation(result.error);
        else this.finish(result, "turn.result");
      }, (error) => { if (this.alive && !task.result) this.observation(error); }).catch((error) => { this.failure = error; });
    } catch (error) {
      if (error.stage === "storage") throw error;
      if (!this.alive || task.result) return;
      if (task.dispatchedAt) this.observation(error);
      else {
        task.error = diagnostic(runtimeError(error, "setup", "session", "SETUP_FAILED"));
        this.beforeDispatch(task.error.code);
      }
    }
  }
  async journal(signal) {
    const task = this.task;
    while (!signal.aborted && (!task.result || !task.result.outputComplete)) {
      try {
        for await (const event of this.runtime.watchSession({ handle: task.handle, cursor: task.cursor, signal })) {
          if (signal.aborted) return;
          if (event.requestId === task.requestId) {
            if (event.type === "turn_started") { task.startedAt ??= this.store.now(); this.progress(); }
            if (event.type === "message") {
              this.progress();
              const update = event.message?.params?.update;
              if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                const output = task.output ??= { text: "", truncated: false };
                if (update.messageId && update.messageId !== output.messageId) Object.assign(output, { text: "", truncated: false, messageId: update.messageId });
                const text = output.text + update.content.text;
                output.text = bounded(text, task.outputLimit); output.truncated ||= text !== output.text;
              }
            }
            if (event.type === "turn_result") {
              if (event.result.error?.detailCode === "WATCH_OUTCOME_UNKNOWN") this.observation(event.result.error);
              else { task.cursor = event.cursor; this.finish(event.result, "watchSession.turn_result", true); return; }
            }
          }
          task.cursor = event.cursor; this.dirty = true; // cursor 与对应输出在循环同次保存。
        }
      } catch (error) { if (error.stage === "storage") throw error; if (!signal.aborted) this.observation(error, "cursor"); }
      if (task.result) return;
      await delay(this.pollMs);
    }
  }
  async deliver() {
    const box = this.box; let retryAfter;
    box.attemptedAt = this.store.now(); save(this.store.filename(this.task.id, "outbox.json"), box);
    try {
      const response = await this.fetcher(box.url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: box.body, redirect: "manual", signal: AbortSignal.timeout(30000) });
      if (response.status === 202) { box.receipt = await receipt(response); box.state = "delivered"; delete box.error; }
      else {
        retryAfter = response.headers.get("retry-after"); await response.body?.cancel();
        const retry = [408, 425, 429].includes(response.status) || response.status >= 500;
        if (!retry) box.state = "rejected";
        box.error = diagnostic(new TaskError(retry ? "CALLBACK_RETRYABLE" : response.status >= 300 && response.status < 400 ? "REDIRECT_REFUSED" : "CALLBACK_REJECTED",
          { stage: "outbox", field: "callback", action: retry ? "recover_original" : "inspect_original" }));
        box.error.http_status = response.status;
      }
    } catch (error) { box.error = diagnostic(error, "outbox", "callback", "DELIVERY_UNCONFIRMED"); }
    if (box.state === "pending") box.nextAttemptAt = this.store.now() + retryDelay(box.attempts++, retryAfter, this.store.now());
    save(this.store.filename(this.task.id, "outbox.json"), box);
  }
  async run(task, { recover = false, signal = new AbortController().signal, deliver = true } = {}) {
    this.task = task; this.box = this.store.outbox(task); this.alive = true;
    const controller = new AbortController(), stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    let journal, delivery, cancellation, setup;
    try {
      if (task.phase === "preparing") throw new TaskError("PREPARATION_INCOMPLETE", { stage: "prepare", field: task.step });
      if (task.phase === "ready") {
        if (this.cancelRequested()) this.beforeDispatch("CANCELLED", true);
        else if (recover) this.beforeDispatch("RECOVERED_BEFORE_DISPATCH");
        else setup = this.start().catch((error) => { this.failure = error; });
      }
      while (!controller.signal.aborted) {
        if (this.failure) throw this.failure;
        if (task.phase === "ready" && this.cancelRequested()) this.beforeDispatch("CANCELLED", true);
        this.timeout();
        if (task.dispatchedAt && !this.runtime && !setup && !task.result) {
          setup = Promise.resolve().then(() => this.connect(task)).then((runtime) => { this.runtime = runtime; }, (error) => {
            this.observation(error, "session"); setup = undefined;
          });
        }
        if (task.dispatchedAt && this.runtime && !journal && (!task.result || !task.result.outputComplete)) {
          journal = this.journal(controller.signal).catch((error) => { this.failure = error; });
        }
        const drained = task.result && (task.result.outputComplete || !journal || this.store.now() >= this.terminalDeadline);
        if (drained && !this.box) {
          let text = task.output?.text ?? "";
          if (task.error) text = `Original request failed: ${task.error.code}. Side effects may have occurred. ${text}`;
          if (!task.result.outputComplete) text = "Output incomplete: the journal did not provide the full output. Do not execute again.\n" + text;
          this.seal(task.result.status, text, "request_result");
        }
        if (deliver && !delivery && this.box?.state === "pending" && this.box.nextAttemptAt <= this.store.now())
          delivery = this.deliver().catch((error) => { this.failure = error; }).finally(() => { delivery = undefined; });
        if (!task.result && task.dispatchedAt && this.runtime && !cancellation && this.cancelRequested()) {
          cancellation = within(this.runtime.cancelRequest({ handle: task.handle, requestId: task.requestId }), this.ioMs)
            .catch(() => {}).finally(() => { cancellation = undefined; });
        }
        if (this.dirty) this.write();
        if (drained && this.box && (!deliver || this.box.state !== "pending") && !delivery) return;
        await delay(this.pollMs);
      }
    } finally {
      this.alive = false; stop(); signal.removeEventListener("abort", stop);
      if (this.dirty) this.write();
      if (this.runtime) await within(this.runtime.shutdown(), this.ioMs).catch(() => {});
    }
  }
}

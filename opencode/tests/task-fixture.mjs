/** Synthetic private input and the fixed acpx surface; no Provider calls. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash, inputHash, save, permissions } from "../scripts/task.mjs";

export function readyTask(store, input = {}, extra = {}) {
  const key = input.key ?? randomUUID(), id = `task_${hash(key)}`;
  const value = { schema_version: 1, key, prompt: "private fixture prompt", callback: {
    callback_id: `tcb_${"x".repeat(43)}`, callback_url: "http://127.0.0.1:1/api/agents/task-callbacks" }, ...input };
  const inputFile = path.join(store.root, `${key}.json`); save(inputFile, value);
  const task = { version: 3, id, key, inputFile, inputHash: inputHash(value, extra.continueFrom),
    phase: "ready", createdAt: store.now(), progress: store.stamp(), noProgressMs: 900000,
    cwd: store.root, git: { repo: store.root, worktree: store.root, branch: "fixture", base: "main", baseSha: "a".repeat(40) },
    model: { id: "fixture/test" }, modelConfig: path.join(store.root, "config.json"), modelProfile: "external",
    permissions: permissions(), sessionKey: id, requestId: randomUUID(), outputLimit: 32768, ...extra };
  fs.mkdirSync(path.dirname(store.filename(id)), { mode: 0o700 }); store.write(task); return task;
}
export const accepted = () => new Response(JSON.stringify({ version: 1, receipt_id: "fixture-receipt", accepted_at: "2026-11-01T00:00:00Z" }), { status: 202 });
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export function mockRuntime(task) {
  let wake, closed = false; const events = [], result = deferred(), started = deferred();
  const handle = { backend: "acpx-shared", cwd: task.cwd, sessionKey: task.sessionKey, acpxRecordId: "record-fixture", backendSessionId: "session-fixture" };
  const runtime = { starts: 0, closes: 0, cancels: [], handle, result, started,
    ensureSession: async () => handle, shutdown: async () => { closed = true; wake?.(); },
    startTurn() { runtime.starts++; return { result: result.promise, promptStarted: started.promise, closeStream: async () => { runtime.closes++; } }; },
    cancelRequest: async (request) => { runtime.cancels.push(request); return true; },
    push(event) { events.push({ cursor: `cursor-${events.length}`, requestId: task.requestId, ...event }); wake?.(); },
    async *watchSession({ signal }) {
      while (!closed && !signal.aborted) {
        if (events.length) yield events.shift();
        else await new Promise((resolve) => { wake = resolve; signal.addEventListener("abort", resolve, { once: true }); });
      }
    },
  };
  return runtime;
}

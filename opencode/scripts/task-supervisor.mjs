/** 每任务一个监护和可替换 driver；driver 丢失后不重放 prompt。 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Confirmation, delay, deliveryState, save } from "./task.mjs";
import { readJson, SNAPSHOT_BYTES } from "./task-read.mjs";

export function readWorkerHeartbeat(filename) {
  return readJson(filename, SNAPSHOT_BYTES, { optional: true });
}

export function workerHeartbeat(runner, id, token) {
  let phase = "starting";
  let sequence = 0;
  const beat = () => save(runner.filename(id, "worker.json"), { token, phase, at: Date.now(), sequence: sequence++ });
  const timer = setInterval(beat, runner.policy.pollMs);
  beat();
  return {
    phase(value) { phase = value; beat(); },
    close() { clearInterval(timer); },
  };
}

async function driver(runner, id, launch, observe, report) {
  const token = randomUUID();
  let child;
  let stopReason;
  const exit = new Promise((resolve) => {
    try {
      child = launch(observe ? "_observe" : "_worker", id, token);
      child.once("error", () => resolve({ code: null, reason: "WORKER_START_FAILED" }));
      child.once("exit", (code) => resolve({ code, reason: stopReason ?? "WORKER_EXITED" }));
    } catch {
      resolve({ code: null, reason: "WORKER_START_FAILED" });
    }
  });
  let observedAt = runner.tick();
  const confirmation = new Confirmation(runner.policy, runner.tick);
  let sequence;
  let checking = false;
  const timer = setInterval(() => {
    if (!child || checking) return;
    checking = true;
    try {
      let beat;
      let unreadable = false;
      try { beat = readWorkerHeartbeat(runner.filename(id, "worker.json")); }
      catch { unreadable = true; } // Untrusted/unreadable samples never renew the lease.
      if (beat) {
        if (beat.token === token && Number.isSafeInteger(beat.sequence) && beat.sequence !== sequence) {
          sequence = beat.sequence;
          observedAt = runner.tick();
        }
      }
      // Once the last valid heartbeat expires, changing read failures cannot renew confirmation.
      const reason = runner.tick() - observedAt > runner.policy.workerMs ? "WORKER_UNRESPONSIVE" :
        unreadable ? "WORKER_HEARTBEAT_UNREADABLE" : undefined;
      const previousSuspicion = confirmation.since;
      if (confirmation.reason && reason && confirmation.reason !== reason) confirmation.update(undefined);
      const confirmed = confirmation.update(reason);
      report(reason, confirmed, previousSuspicion !== confirmation.since);
      if (confirmed) {
        stopReason = reason;
        // Only this unreaped child is signalled. Never act on a persisted PID.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    } finally {
      checking = false;
    }
  }, runner.policy.pollMs);
  try {
    return await exit;
  } finally {
    clearInterval(timer);
  }
}

export async function supervise(runner, id, launch) {
  let record = runner.load(id);
  if (["delivered", "rejected"].includes(deliveryState(record))) return;
  let workerAssessment = "observing";
  let workerSuspectedAt;
  const beat = () => save(runner.filename(id, "monitor.json"), { at: Date.now(), workerAssessment, workerSuspectedAt });
  const report = (reason, confirmed, restarted) => {
    workerAssessment = confirmed ? "stopping" : reason ? "suspected" : "observing";
    workerSuspectedAt = reason ? restarted ? Date.now() : workerSuspectedAt ?? Date.now() : undefined;
    beat();
  };
  beat();
  const timer = setInterval(beat, runner.policy.pollMs);
  let observe = record.state !== "queued" || Boolean(record.workerAttemptedAt);
  try { while (true) {
    if (record.body) {
      if (deliveryState(record) !== "outbox") return;
      await delay(Math.max(0, record.nextAttemptAt - Date.now()));
      await runner.deliver(record);
      record = runner.load(id);
      continue;
    }
    const outcome = await driver(runner, id, launch, observe, report);
    record = runner.load(id);
    if (outcome.code === 75) {
      // A prior driver still holds the kernel lock. Its PID is irrelevant.
      await delay(runner.policy.pollMs);
      observe = true;
      continue;
    }
    record.workerExit = { code: outcome.code, reason: outcome.reason, observedAt: Date.now() };
    runner.write(record);
    if (record.body) continue;
    if (record.state === "queued" || observe) {
      runner.fail(record, outcome.reason);
    } else {
      record.executionError = outcome.reason;
      runner.write(record);
    }
    observe = true;
  } } finally { clearInterval(timer); }
}

export function launchDriver(version, id, token, command) {
  return spawn("python3", ["-B", `${version}/runtime.py`, "opencode-task", command, id, token], {
    cwd: process.cwd(), env: { ...process.env, OPENCODE_MODULE_MONITOR_PID: String(process.pid) }, stdio: "ignore",
  });
}

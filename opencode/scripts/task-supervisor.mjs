/** One task, one monitor, one replaceable driver. No prompt replay after a lost driver. */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Confirmation, delay, deliveryState, save } from "./task.mjs";

export function readWorkerHeartbeat(filename) {
  // rename may unlink the inode between lookup and stat. Validate/read one fd;
  // retry only that replaced private inode, without relaxing link/permission checks.
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077)
        throw new Error("UNSAFE_TASK_FILE");
      if (info.nlink === 0) continue;
      if (info.nlink !== 1) throw new Error("UNSAFE_TASK_FILE");
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  }
  // No verified sample: retain the original last-progress budget and confirmation.
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

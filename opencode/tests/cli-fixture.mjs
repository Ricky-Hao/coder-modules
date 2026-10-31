/** 仅供隔离 CLI 夹具：独立采样短暂状态，清理时等待自有出生身份停止写入。 */
import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!isMainThread && workerData?.kind === "health-witness") {
  let suspected;
  let resumed = false;
  const timer = setInterval(() => {
    if (!fs.existsSync(workerData.taskFile)) return;
    const record = JSON.parse(fs.readFileSync(workerData.taskFile, "utf8"));
    const snapshot = { state: record.state, requestId: record.requestId, health: record.health,
      sessionId: record.handle?.backendSessionId, bodyPresent: Boolean(record.body),
      assistantOutput: Boolean(record.output), at: Date.now() };
    if (suspected === undefined && record.health?.assessment === "suspected" &&
        record.health.suspectedReason === "PROGRESS_UNCONFIRMED") {
      suspected = record.health.eventSequence;
      parentPort.postMessage({ type: "suspected", snapshot });
      if (workerData.resumeDirectory) fs.writeFileSync(path.join(workerData.resumeDirectory, snapshot.sessionId), "resume synthetic thought");
    } else if (suspected !== undefined && !resumed && record.health?.assessment === "observing" &&
        record.health.eventSequence > suspected) {
      resumed = true;
      parentPort.postMessage({ type: "resumed", snapshot });
    }
    if (record.body) {
      parentPort.postMessage({ type: "sealed", snapshot });
      clearInterval(timer);
      parentPort.close();
    }
  }, 10);
  parentPort.postMessage({ type: "ready" });
}

export async function startHealthWitness(taskFile, resumeDirectory) {
  const events = {};
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: "health-witness", taskFile, resumeDirectory } });
  await new Promise((resolve, reject) => {
    worker.on("message", ({ type, snapshot }) => { events[type] = snapshot ?? true; if (type === "ready") resolve(); });
    worker.on("error", (error) => { events.error = error.message; reject(error); });
    worker.on("exit", (code) => { if (code) events.error ??= `health witness exit ${code}`; });
  });
  return { events, close: () => worker.terminate() };
}

export function processBirth(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).trim().split(/\s+/);
    return { ticks: fields[19], state: fields[0] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

export async function stopFixtureProcesses(base, version) {
  const allowed = new Set([path.join(base, "toolset/bin/opencode-task"),
    path.join(version, "runtime.py"), path.join(version, "task-cli.mjs"), path.join(version, "node/bin/node")]);
  const readLines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").slice(0, -1).map(JSON.parse) : [];
  const verified = new Set();
  const live = (proof) => {
    const birth = processBirth(proof.pid);
    if (!birth || birth.ticks !== proof.ticks || ["Z", "X"].includes(birth.state)) return false;
    let argv;
    try { argv = fs.readFileSync(`/proc/${proof.pid}/cmdline`, "utf8").split("\0"); }
    catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; throw error; }
    const current = processBirth(proof.pid);
    if (!current || current.ticks !== proof.ticks || ["Z", "X"].includes(current.state)) return false;
    // 退出期间 cmdline 可先清空、stat 稍后才变 Z；只继续等待先前已核对的同一出生身份。
    if (argv.every((arg) => !arg)) return verified.has(`${proof.pid}:${proof.ticks}`);
    if (!argv.some((arg) => allowed.has(arg))) throw new Error(`fixture process command mismatch: ${proof.pid}`);
    verified.add(`${proof.pid}:${proof.ticks}`);
    return true;
  };
  const stop = async (proofs) => {
    const targets = [...new Map(proofs.map((proof) => [`${proof.pid}:${proof.ticks}`, proof])).values()];
    const signal = (value) => {
      for (const proof of targets) if (live(proof)) {
        try { process.kill(proof.pid, value); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    };
    signal("SIGTERM");
    let deadline = performance.now() + 2000;
    while (targets.some(live) && performance.now() < deadline) await pause(20);
    signal("SIGKILL"); // 覆盖仍在 SIGSTOP 的本夹具进程，每次信号前重新核对出生身份。
    deadline = performance.now() + 2000;
    while (targets.some(live) && performance.now() < deadline) await pause(20);
    if (targets.some(live)) throw new Error("fixture processes still writing; temporary root retained");
  };
  const drivers = () => readLines(path.join(base, "drivers.ndjson"));
  // 也捕获尚在 runtime.py 初始化、来不及写 Node 出生清单的自有子进程。
  const descendants = (parents) => {
    const found = new Map();
    const visit = (proof) => {
      if (!live(proof) || found.has(`${proof.pid}:${proof.ticks}`)) return;
      found.set(`${proof.pid}:${proof.ticks}`, proof);
      let children;
      try { children = fs.readFileSync(`/proc/${proof.pid}/task/${proof.pid}/children`, "utf8"); }
      catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return; throw error; }
      for (const child of children.trim().split(/\s+/).filter(Boolean)) {
        const birth = processBirth(Number(child));
        if (birth) visit({ pid: Number(child), ticks: birth.ticks });
      }
    };
    for (const proof of parents) visit(proof);
    return [...found.values()];
  };
  const spawning = descendants(drivers());
  await stop(drivers().filter(({ role }) => ["_supervise", "_fail_launch"].includes(role)));
  // monitor 已退出，不能再出生替换 worker；重新读取清单，覆盖 _observe 及失败启动。
  await stop([...spawning, ...descendants(drivers()), ...drivers()]);
  const peers = () => readLines(path.join(base, "processes"));
  const queues = path.join(base, "toolset/runtime/home/.acpx/queues");
  const leases = fs.existsSync(queues) ? fs.readdirSync(queues).filter((name) => name.endsWith(".lock")).map((name) =>
    JSON.parse(fs.readFileSync(path.join(queues, name), "utf8"))) : [];
  await stop([...peers().map((proof) => ({ pid: proof.owner, ticks: proof.ownerStartTicks })),
    ...leases.filter((lease) => lease.processIdentity?.kind === "linux-proc").map((lease) =>
      ({ pid: lease.pid, ticks: lease.processIdentity.startTicks }))]);
  await stop(peers().map((proof) => ({ pid: proof.agent, ticks: proof.startTicks })));
}

export async function finishFixture(primaryError, cleanup, diagnostic) {
  let cleanupError;
  try { await cleanup(); } catch (error) { cleanupError = error; }
  if (cleanupError) diagnostic({ phase: "cleanup_failed", code: cleanupError.code ?? null, message: cleanupError.message });
  if (primaryError) throw primaryError; // 首错对象/stack 原样保留，finally 不能覆盖它。
  if (cleanupError) throw cleanupError;
}

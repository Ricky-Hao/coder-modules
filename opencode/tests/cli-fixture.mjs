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
      if (workerData.resumeDirectory) {
        const evidence = path.join(workerData.resumeDirectory, `${snapshot.sessionId}.suspected.json`);
        fs.writeFileSync(evidence + ".tmp", JSON.stringify({ suspectedAt: snapshot.health.suspectedAt }));
        fs.renameSync(evidence + ".tmp", evidence);
        fs.writeFileSync(path.join(workerData.resumeDirectory, snapshot.sessionId), "resume synthetic thought");
      }
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

export function recordFixtureSpawns(source, filename) {
  const imported = 'import { spawn } from "node:child_process";';
  if (!source.includes(imported)) throw new Error("fixture spawn instrumentation no longer matches source");
  // 复制脚本的父 spawn 点立即登记，覆盖 child 尚在 Python 初始化且 submit 已退出的窗口。
  return source.replace(imported, `import { spawn as fixtureNativeSpawn } from "node:child_process";
const spawn = (...args) => {
  const child = fixtureNativeSpawn(...args);
  if (child.pid) {
    try {
      const ticks = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8').split(') ').at(-1).trim().split(/\\s+/)[19];
      const role = args[1]?.find((arg) => ['_worker', '_observe', '_supervise', '_fail_launch'].includes(arg)) ?? 'spawned';
      const taskId = args[1]?.find((arg) => /^task_[a-f0-9]{64}$/.test(arg));
      fs.appendFileSync(${JSON.stringify(filename)}, JSON.stringify({ pid: child.pid, ticks, role, taskId }) + '\\n');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return child;
};`);
}

export function fixtureProcessSnapshot(base) {
  const file = path.join(base, "drivers.ndjson");
  if (!fs.existsSync(file)) return [];
  const proofs = fs.readFileSync(file, "utf8").split("\n").slice(0, -1).map(JSON.parse);
  return [...new Map(proofs.map((proof) => [`${proof.pid}:${proof.ticks}`, proof])).values()].map((proof) => {
    const birth = processBirth(proof.pid);
    let waiting = null;
    if (birth?.ticks === proof.ticks) {
      try { waiting = fs.readFileSync(`/proc/${proof.pid}/wchan`, "utf8").trim(); } catch { /* 退出与读取可竞争。 */ }
    }
    return { ...proof, same_birth: birth?.ticks === proof.ticks, state: birth?.state ?? null, waiting };
  });
}

export async function stopFixtureProcesses(base, version) {
  const root = path.join(base, "toolset");
  const allowed = new Set([path.join(root, "bin/opencode-task"), path.join(root, "bin/opencode"),
    ...[version, path.join(root, "active")].flatMap((directory) =>
      ["runtime.py", "task-cli.mjs", "node/bin/node", "opencode"].map((name) => path.join(directory, name)))]);
  const readLines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").slice(0, -1).map(JSON.parse) : [];
  const live = (proof, purpose = "wait") => {
    if (!Number.isSafeInteger(proof.pid) || proof.pid <= 1 || proof.pid === process.pid ||
        typeof proof.ticks !== 'string' || !/^\d+$/.test(proof.ticks)) throw new Error('unsafe fixture process identity');
    const birth = processBirth(proof.pid);
    if (!birth || birth.ticks !== proof.ticks || ["Z", "X"].includes(birth.state)) return false;
    let argv;
    try { argv = fs.readFileSync(`/proc/${proof.pid}/cmdline`, "utf8").split("\0"); }
    catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; throw error; }
    const current = processBirth(proof.pid);
    if (!current || current.ticks !== proof.ticks || ["Z", "X"].includes(current.state)) return false;
    // exec/退出期间 cmdline 可为空：仍是活进程，命令未核实时只等待、绝不发信号。
    if (argv.every((arg) => !arg)) return purpose !== "signal";
    if (!argv.some((arg) => allowed.has(arg))) throw new Error(`fixture process command mismatch: ${proof.pid}`);
    return true;
  };
  const stop = async (proofs) => {
    const targets = [...new Map(proofs.map((proof) => [`${proof.pid}:${proof.ticks}`, proof])).values()];
    const terminated = new Map();
    const killed = new Set();
    const deadline = performance.now() + 6000;
    while (targets.some(live)) {
      const at = performance.now();
      for (const proof of targets) if (live(proof, "signal")) {
        const key = `${proof.pid}:${proof.ticks}`;
        const first = !terminated.has(key);
        if (first || at - terminated.get(key) >= 2000 && !killed.has(key)) {
          try { process.kill(proof.pid, first ? "SIGTERM" : "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
          if (first) terminated.set(key, at);
          else killed.add(key);
        }
      }
      if (performance.now() >= deadline) throw new Error("fixture processes still writing or unverified; temporary root retained");
      await pause(20);
    }
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
  const errors = [];
  const attempt = async (action) => { try { return await action(); } catch (error) { errors.push(error); } };
  const spawning = await attempt(() => descendants(drivers())) ?? [];
  await attempt(() => stop(drivers().filter(({ role }) => ["_supervise", "_fail_launch"].includes(role))));
  // monitor 已退出，不能再出生替换 worker；重新读取清单，覆盖 _observe 及失败启动。
  await attempt(() => stop([...spawning, ...descendants(drivers()), ...drivers()]));
  const peers = () => readLines(path.join(base, "processes"));
  const queues = path.join(base, "toolset/runtime/home/.acpx/queues");
  const leases = await attempt(() => fs.existsSync(queues) ? fs.readdirSync(queues).filter((name) => name.endsWith(".lock")).map((name) =>
    JSON.parse(fs.readFileSync(path.join(queues, name), "utf8"))) : []) ?? [];
  await attempt(() => stop([...peers().filter((proof) => !proof.invalidOwner && proof.owner > 1 && proof.owner !== process.pid)
    .map((proof) => ({ pid: proof.owner, ticks: proof.ownerStartTicks })),
    ...leases.filter((lease) => lease.processIdentity?.kind === "linux-proc").map((lease) =>
      ({ pid: lease.pid, ticks: lease.processIdentity.startTicks }))]));
  // 不可信 parent 不是 owner；真正 owned writer 命令不符仍报错并保留 root，同时收尾已确认 agent。
  await attempt(() => stop(peers().map((proof) => ({ pid: proof.agent, ticks: proof.startTicks }))));
  if (errors.length) throw errors[0];
}

export async function finishFixture(primaryError, cleanup, diagnostic) {
  let cleanupError;
  try { await cleanup(); } catch (error) { cleanupError = error; }
  if (cleanupError) {
    try { diagnostic({ phase: "cleanup_failed", code: cleanupError.code ?? null, message: cleanupError.message }); }
    catch { /* 诊断自身失败也不能替代已经存在的首错。 */ }
  }
  if (primaryError) throw primaryError; // 首错对象/stack 原样保留，finally 不能覆盖它。
  if (cleanupError) throw cleanupError;
}

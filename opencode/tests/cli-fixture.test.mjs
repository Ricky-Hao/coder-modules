import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { processBirth, stopFixtureProcesses, finishFixture, recordFixtureSpawns } from "./cli-fixture.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assertStopped = ({ pid, ticks }) => {
  const birth = processBirth(pid);
  assert.ok(!birth || birth.ticks !== ticks || ["Z", "X"].includes(birth.state), `fixture birth still live: ${pid}`);
};

test("cleanup waits for a late directory writer and a stopped child; mismatched birth is untouched", { timeout: 10000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cleanup-"));
  const version = path.join(base, "toolset/versions/fixture");
  fs.mkdirSync(version, { recursive: true });
  const script = path.join(version, "runtime.py");
  fs.writeFileSync(script, `import os, signal, sys, time
from pathlib import Path
def end(signum, frame):
    time.sleep(0.15)
    target = Path(sys.argv[1]) / 'toolset/runtime/recreated-on-exit'
    target.mkdir(parents=True, exist_ok=True)
    (target / 'done').write_text('late fixture write')
    print('late-write', flush=True)
    sys.exit(0)
signal.signal(signal.SIGTERM, end)
print('ready', flush=True)
while True: time.sleep(0.01)
`);
  const children = [];
  const launch = async () => {
    const child = spawn("python3", ["-B", script, base], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    const exit = new Promise((resolve) => child.once("exit", resolve));
    children.push({ child, exit });
    await new Promise((resolve, reject) => { child.once("error", reject); child.stdout.once("data", resolve); });
    return { child, exit, output: () => output, proof: { pid: child.pid, ticks: processBirth(child.pid).ticks, role: "_worker" } };
  };
  try {
    const writer = await launch();
    const stopped = await launch();
    const unrelated = await launch();
    process.kill(stopped.child.pid, "SIGSTOP");
    const stopDeadline = performance.now() + 1000;
    while (!["T", "t"].includes(processBirth(stopped.child.pid)?.state) && performance.now() < stopDeadline) await pause(5);
    assert.ok(["T", "t"].includes(processBirth(stopped.child.pid)?.state));
    const stale = { ...unrelated.proof, ticks: String(BigInt(unrelated.proof.ticks) + 1n) };
    fs.writeFileSync(path.join(base, "drivers.ndjson"), [writer.proof, stopped.proof, stale].map(JSON.stringify).join("\n") + "\n");
    await stopFixtureProcesses(base, version);
    // 不能用后续外部 wait 掩盖 cleanup 提前返回；此刻必须已经不可写，延迟写入也已完成。
    assertStopped(writer.proof);
    assertStopped(stopped.proof);
    assert.ok(fs.existsSync(path.join(base, "toolset/runtime/recreated-on-exit/done")));
    await Promise.all([writer.exit, stopped.exit]);
    assert.match(writer.output(), /late-write/);
    assert.equal(unrelated.child.exitCode, null);
    assert.equal(unrelated.child.signalCode, null);
    unrelated.child.kill("SIGKILL");
    await unrelated.exit;
    fs.rmSync(base, { recursive: true, force: true });
    assert.equal(fs.existsSync(base), false);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ exit }) => exit));
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("parent spawn records detached children before their own entry; active and wrapper paths are scoped", { timeout: 10000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cli-spawn-"));
  const root = path.join(base, "toolset");
  const version = path.join(root, "versions/fixture");
  fs.mkdirSync(version, { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  fs.symlinkSync("versions/fixture", path.join(root, "active"));
  fs.writeFileSync(path.join(version, "runtime.py"), "import time\ntime.sleep(30)\n");
  const fifo = path.join(base, "hold");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  for (const name of [path.join(root, "bin/opencode"), path.join(version, "opencode")])
    fs.writeFileSync(name, `trap 'exit 0' TERM\nexec 9<> '${fifo}'\nread -r -u 9 value\n`);
  const entries = [["python3", ["-B", path.join(root, "active/runtime.py"), "_supervise"]],
    ["bash", [path.join(root, "bin/opencode")]], ["bash", [path.join(root, "active/opencode")]],
    ["bash", [path.join(version, "opencode")]]];
  try {
    const parent = path.join(version, "task-cli.mjs");
    for (const [command, args] of entries) {
      const source = `import fs from 'node:fs';\nimport { spawn } from "node:child_process";\n` +
        `const child = spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, {detached:true, stdio:'ignore'}); child.unref();\n`;
      fs.writeFileSync(parent, recordFixtureSpawns(source, path.join(base, "drivers.ndjson")));
      const result = spawnSync(process.execPath, [parent], { timeout: 3000, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const proofs = fs.readFileSync(path.join(base, "drivers.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(proofs.length, entries.length);
    assert.ok(proofs.every((proof) => processBirth(proof.pid)?.ticks === proof.ticks));
    await stopFixtureProcesses(base, version);
    for (const proof of proofs) assertStopped(proof);
  } finally {
    await stopFixtureProcesses(base, version);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup failure retains the original failure object and reports both failures", async () => {
  const primary = new Error("first assertion at thought control");
  const cleanup = Object.assign(new Error("cleanup cannot remove a writing root"), { code: "ENOTEMPTY" });
  const diagnostics = [];
  await assert.rejects(finishFixture(primary, async () => { throw cleanup; }, (value) => diagnostics.push(value)),
    (error) => error === primary);
  assert.equal(diagnostics[0].code, "ENOTEMPTY");
  await assert.rejects(finishFixture(null, async () => { throw cleanup; }, () => {}), (error) => error === cleanup);
  const brokenDiagnostic = () => { throw new Error("diagnostic sink unavailable"); };
  await assert.rejects(finishFixture(primary, async () => { throw cleanup; }, brokenDiagnostic), (error) => error === primary);
  await assert.rejects(finishFixture(null, async () => { throw cleanup; }, brokenDiagnostic), (error) => error === cleanup);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { processBirth, stopFixtureProcesses, finishFixture } from "./cli-fixture.mjs";

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
    const stale = { ...unrelated.proof, ticks: String(BigInt(unrelated.proof.ticks) + 1n) };
    fs.writeFileSync(path.join(base, "drivers.ndjson"), [writer.proof, stopped.proof, stale].map(JSON.stringify).join("\n") + "\n");
    await stopFixtureProcesses(base, version);
    await Promise.all([writer.exit, stopped.exit]);
    assert.match(writer.output(), /late-write/);
    assert.ok(fs.existsSync(path.join(base, "toolset/runtime/recreated-on-exit/done")));
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

test("cleanup failure retains the original failure object and reports both failures", async () => {
  const primary = new Error("first assertion at thought control");
  const cleanup = Object.assign(new Error("cleanup cannot remove a writing root"), { code: "ENOTEMPTY" });
  const diagnostics = [];
  await assert.rejects(finishFixture(primary, async () => { throw cleanup; }, (value) => diagnostics.push(value)),
    (error) => error === primary);
  assert.equal(diagnostics[0].code, "ENOTEMPTY");
  await assert.rejects(finishFixture(null, async () => { throw cleanup; }, () => {}), (error) => error === cleanup);
});

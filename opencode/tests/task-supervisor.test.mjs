import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { save } from "../scripts/task.mjs";
import { readWorkerHeartbeat } from "../scripts/task-supervisor.mjs";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "task-heartbeat-"));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const filename = path.join(base, "worker.json");
  save(filename, { sequence: 0 });
  return { base, filename };
}

for (const replacements of [1, 3]) {
  test(`heartbeat retries a real unlinked inode; ${replacements} replacement(s) are bounded`, (t) => {
    const { filename } = fixture(t);
    const stat = fs.fstatSync;
    const close = fs.closeSync;
    let sampled = 0;
    let closed = 0;
    const unlinked = [];
    fs.fstatSync = (fd) => {
      if (sampled++ < replacements) save(filename, { sequence: sampled });
      const info = stat(fd);
      unlinked.push(info.nlink);
      return info;
    };
    fs.closeSync = (fd) => { closed++; return close(fd); };
    let result;
    try { result = readWorkerHeartbeat(filename); }
    finally { fs.fstatSync = stat; fs.closeSync = close; }
    assert.deepEqual(unlinked, replacements === 1 ? [0, 1] : [0, 0, 0]);
    // Each save closes its data and directory fd; each attempted heartbeat fd also closes.
    assert.equal(closed, replacements * 2 + unlinked.length);
    assert.deepEqual(result, replacements === 1 ? { sequence: 1 } : undefined);
    assert.deepEqual(readWorkerHeartbeat(filename), { sequence: replacements });
  });
}

test("heartbeat still rejects hard links, symlinks, public mode, wrong owner, directories and corrupt JSON", (t) => {
  const { base, filename } = fixture(t);
  const hardlink = path.join(base, "alias");
  fs.linkSync(filename, hardlink);
  assert.throws(() => readWorkerHeartbeat(filename), /UNSAFE_TASK_FILE/);
  fs.unlinkSync(hardlink);
  const symlink = path.join(base, "symlink");
  fs.symlinkSync(filename, symlink);
  assert.throws(() => readWorkerHeartbeat(symlink), (error) => error.code === "ELOOP");
  fs.chmodSync(filename, 0o644);
  assert.throws(() => readWorkerHeartbeat(filename), /UNSAFE_TASK_FILE/);
  fs.chmodSync(filename, 0o600);
  if (process.getuid() === 0) {
    fs.chownSync(filename, 1, process.getgid());
    assert.throws(() => readWorkerHeartbeat(filename), /UNSAFE_TASK_FILE/);
    fs.chownSync(filename, process.getuid(), process.getgid());
  }
  assert.throws(() => readWorkerHeartbeat(base), /UNSAFE_TASK_FILE/);
  fs.writeFileSync(filename, "invalid json");
  assert.throws(() => readWorkerHeartbeat(filename), SyntaxError);
  assert.equal(readWorkerHeartbeat(path.join(base, "absent")), undefined);
  // Check fd closure independently of the error, including parsing failure.
  const open = fs.openSync;
  const stat = fs.fstatSync;
  let rejectedFd;
  fs.openSync = (...args) => { const fd = open(...args); if (args[0] === filename) rejectedFd = fd; return fd; };
  try { assert.throws(() => readWorkerHeartbeat(filename), SyntaxError); }
  finally { fs.openSync = open; }
  assert.throws(() => stat(rejectedFd), (error) => error.code === "EBADF");
});

test("heartbeat rejects a FIFO without waiting for a writer", (t) => {
  const { base } = fixture(t);
  const fifo = path.join(base, "pipe");
  assert.equal(spawnSync("mkfifo", ["-m", "600", fifo]).status, 0);
  const code = `import assert from 'node:assert/strict';
import { readWorkerHeartbeat } from ${JSON.stringify(new URL("../scripts/task-supervisor.mjs", import.meta.url).href)};
assert.throws(() => readWorkerHeartbeat(process.argv[1]), /UNSAFE_TASK_FILE/);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, fifo], { timeout: 2000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

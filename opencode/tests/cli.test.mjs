import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TaskRunner } from "../scripts/task.mjs";
import { stopFixtureProcesses, finishFixture, recordFixtureSpawns, fixtureProcessSnapshot, processBirth } from "./cli-fixture.mjs";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("real wrapper/CLI: one control, durable launch, explicit recover, exact outbox, late canonical and request cancel isolation",
  { timeout: 120000 }, async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "module-cli-"));
    const root = path.join(base, "toolset"), version = path.join(root, "versions/fixture");
    fs.mkdirSync(version, { recursive: true, mode: 0o700 });
    for (const name of ["runtime.py", "diagnostics.py", "safety.py", "profiles.py", "profile-env.json", "task.mjs", "task-read.mjs", "task-launch.mjs", "task-cli.mjs", "task-acp.mjs"])
      fs.copyFileSync(path.join(scripts, name), path.join(version, name));
    const copiedCli = path.join(version, "task-cli.mjs");
    fs.writeFileSync(copiedCli, recordFixtureSpawns(fs.readFileSync(copiedCli, "utf8"), path.join(base, "drivers.ndjson")));
    fs.mkdirSync(path.join(version, "node/bin"), { recursive: true, mode: 0o700 });
    fs.copyFileSync(process.execPath, path.join(version, "node/bin/node"));
    fs.cpSync(path.join(scripts, "node_modules"), path.join(version, "node_modules"), { recursive: true });
    for (const name of ["bin", "runtime", ...["home", "config", "data", "cache", "state", "tmp"].map((n) => `runtime/${n}`)])
      fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    write(path.join(root, "owner.json"), { schema: 1, uid: process.getuid(), workspace_id: "cli-fixture" });
    write(path.join(version, "settings.json"), { install_root: root, workspace_id: "cli-fixture", runtime_profile: "env" });
    fs.symlinkSync("versions/fixture", path.join(root, "active"));
    for (const tool of ["opencode", "opencode-task"])
      fs.writeFileSync(path.join(root, "bin", tool), `#!/usr/bin/env bash\nexec python3 -B ${quote(path.join(root, "active/runtime.py"))} ${tool} "$@"\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(version, "opencode"), `#!/usr/bin/env bash\nexec ${quote(path.join(version, "node/bin/node"))} ${quote(fileURLToPath(new URL("./acp.fixture.mjs", import.meta.url)))} "$@"\n`, { mode: 0o700 });
    fs.mkdirSync(path.join(root, "runtime/home/.acpx"), { mode: 0o700 });
    write(path.join(root, "runtime/home/.acpx/config.json"), { defaultAgent: "opencode", defaultPermissions: "deny-all", nonInteractivePermissions: "deny", authPolicy: "skip",
      agents: { opencode: { argv: [path.join(root, "bin/opencode"), "acp"] } } });
    const progress = path.join(base, "progress-control"); fs.mkdirSync(progress, { mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: base, CODEX_BASE_URL: "http://127.0.0.1:1/v1", CODEX_API_KEY: "synthetic-codex",
      COPILOT_BASE_URL: "http://127.0.0.1:1/v1", COPILOT_API_KEY: "synthetic-copilot",
      TASK_FIXTURE_LOG: path.join(base, "executions"), TASK_FIXTURE_PROCESS_LOG: path.join(base, "processes"),
      TASK_FIXTURE_EVENT_LOG: path.join(base, "events.ndjson"), TASK_FIXTURE_PROGRESS_CONTROL: progress,
      LC_TASK_CALLBACK_URL: "private-protocol-field", UNLISTED_CALLBACK_BEARER: `tcb_${"e".repeat(43)}` };
    const cli = (args) => spawnSync(path.join(root, "bin/opencode-task"), args, { cwd: base, env, encoding: "utf8", timeout: 15000 });
    const checked = (args) => { const result = cli(args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
    const lines = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const until = async (predicate, label, ms = 15000) => {
      const end = performance.now() + ms;
      while (!predicate()) { if (performance.now() > end) throw new Error(`fixture timeout: ${label}; root=${base}`); await pause(30); }
    };
    const seen = [], receipts = new Map(); let drop = true;
    const webhook = http.createServer((req, res) => {
      let body = ""; req.on("data", (data) => { body += data; }); req.on("end", () => {
        seen.push(body); const id = JSON.parse(body).callback_id;
        if (!receipts.has(id)) receipts.set(id, body);
        assert.equal(body, receipts.get(id));
        if (drop) { drop = false; req.socket.destroy(); }
        else { res.writeHead(202); res.end(JSON.stringify({ version: 1, receipt_id: "durable-fixture", accepted_at: new Date().toISOString() })); }
      });
    });
    await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const git = (cwd, ...args) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    const repo = path.join(base, "repo"), origin = path.join(base, "origin"); fs.mkdirSync(repo); fs.mkdirSync(origin);
    git(origin, "init", "--bare", "--initial-branch=main"); git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(repo, "tracked"), "base\n"); git(repo, "add", "tracked"); git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", origin); git(repo, "push", "origin", "main");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const callback = (letter) => ({ callback_id: `tcb_${letter.repeat(43)}`, callback_url: `http://127.0.0.1:${webhook.address().port}/api/agents/task-callbacks` });
    const input = (key, prompt, letter, extra = {}) => ({ schema_version: 1, key, prompt, callback: callback(letter),
      repo_path: repo, branch: `fixture/${key}`, worktree: `work-${key}`, ...extra });
    const inputFile = (value) => { const file = path.join(base, value.key + ".json"); write(file, value); return file; };
    const launch = (value, from) => checked(["launch", "--input-file", inputFile(value), ...(from ? ["--continue-from", from] : [])]);
    const load = (id) => JSON.parse(fs.readFileSync(path.join(root, "runtime/tasks", id, "task.json"), "utf8"));
    const controls = (id) => fixtureProcessSnapshot(base).filter((proof) => proof.role === "_run" && proof.taskId === id && proof.same_birth && !["Z", "X"].includes(proof.state));
    const killControl = async (id) => {
      const proofs = controls(id); assert.equal(proofs.length, 1); const proof = proofs[0];
      assert.equal(processBirth(proof.pid)?.ticks, proof.ticks); process.kill(proof.pid, "SIGKILL");
      await until(() => !controls(id).length, "control stopped");
    };
    let primaryError;
    try {
      const firstInput = input("first", "model selection", "a"), first = launch(firstInput);
      assert.equal(first.base_sha, baseSha); assert.equal(first.accepted, true);
      await until(() => load(first.task_id).attempts === 1, "lost receipt persisted");
      const exact = load(first.task_id).body; await killControl(first.task_id);
      const attempts = seen.length; await pause(300); assert.equal(seen.length, attempts);
      checked(["recover", first.task_id]);
      await until(() => load(first.task_id).callbackState === "delivered", "explicit outbox recover");
      assert.equal(load(first.task_id).body, exact);
      const selected = JSON.parse(checked(["result", first.task_id]).output);
      assert.equal(selected.model, "codex/gpt-6.1-sol"); assert.equal(selected.effort, "max");
      assert.equal(selected.title.variant, "low");
      assert.equal(launch(firstInput).request_id, first.request_id);
      const follow = launch({ schema_version: 1, key: "follow", prompt: "continuity", callback: callback("b") }, first.task_id);
      await until(() => load(follow.task_id).callbackState === "delivered", "trusted followup");
      assert.equal(checked(["result", follow.task_id]).output, "Session turn 2");
      assert.equal(load(follow.task_id).handle.backendSessionId, load(first.task_id).handle.backendSessionId);

      let prior = follow.task_id;
      for (const [key, letter, permissions, allowed] of [
        ["deny-write", "k", undefined, false],
        ["policy-write", "l", { mode: "approve-all", policy: { autoDeny: ["edit"] } }, false],
        ["allow-write", "m", { mode: "approve-all", policy: {} }, true],
      ]) {
        const selected = launch({ schema_version: 1, key, prompt: "write fixture", callback: callback(letter),
          ...(permissions ? { permissions } : {}) }, prior);
        await until(() => load(selected.task_id).callbackState === "delivered", "per-turn permissions");
        assert.match(checked(["result", selected.task_id]).output, allowed ? /Write permitted/ : /Write denied/);
        assert.equal(fs.existsSync(path.join(follow.worktree, "authorized-write.txt")), allowed);
        prior = selected.task_id;
      }

      const waiting = launch(input("waiting", "wait for cancellation", "c", { no_progress_timeout_seconds: 10 }));
      await until(() => load(waiting.task_id).startedAt, "waiting started");
      assert.equal(controls(waiting.task_id).length, 1);
      for (const name of ["monitor.lock", "worker.lock", "monitor.json", "worker.json"])
        assert.equal(fs.existsSync(path.join(root, "runtime/tasks", waiting.task_id, name)), false);
      await killControl(waiting.task_id);
      const requestId = load(waiting.task_id).requestId;
      const executionCount = fs.readFileSync(env.TASK_FIXTURE_LOG, "utf8").trim().split("\n").length;
      await pause(350); assert.equal(controls(waiting.task_id).length, 0);
      checked(["recover", waiting.task_id]);
      await until(() => controls(waiting.task_id).length === 1, "original observer recovered");
      const observer = controls(waiting.task_id)[0];
      checked(["recover", waiting.task_id]);
      await until(() => controls(waiting.task_id).length === 1, "duplicate recover exits without lock");
      assert.equal(controls(waiting.task_id).length, 1);
      assert.equal(controls(waiting.task_id)[0].pid, observer.pid);
      checked(["cancel", waiting.task_id]);
      await until(() => load(waiting.task_id).result?.status === "cancelled", "canonical cancel");
      assert.equal(load(waiting.task_id).requestId, requestId);
      assert.equal(fs.readFileSync(env.TASK_FIXTURE_LOG, "utf8").trim().split("\n").length, executionCount);

      const late = launch(input("late", "controlled task", "d", { no_progress_timeout_seconds: 2 }));
      await until(() => load(late.task_id).startedAt, "controlled started");
      const sessionId = load(late.task_id).handle.backendSessionId;
      fs.writeFileSync(path.join(progress, sessionId + ".stall"), "stall");
      await until(() => load(late.task_id).callbackState === "delivered", "one unknown callback");
      const body = load(late.task_id).body, posts = seen.length;
      assert.equal(checked(["status", late.task_id]).result_status, null);
      const busy = cli(["launch", "--input-file", inputFile({ schema_version: 1, key: "busy", prompt: "next", callback: callback("f") }), "--continue-from", late.task_id]);
      assert.equal(JSON.parse(busy.stdout).error.code, "CONTINUE_BUSY_OR_UNKNOWN");
      fs.writeFileSync(path.join(progress, sessionId + ".finish"), "finish");
      await until(() => load(late.task_id).result?.status === "success", "late canonical");
      assert.equal(checked(["result", late.task_id]).output, "Controlled result");
      assert.equal(load(late.task_id).body, body); assert.equal(seen.length, posts);

      // 同一 session 的请求级 queued cancel；另一条 queued 请求继续执行。
      const source = load(late.task_id);
      const runner = new TaskRunner({ root: path.join(root, "runtime/tasks") });
      const internal = (key, prompt, letter) => runner.submit({ key, cwd: source.cwd, prompt, callback: callback(letter), session: source.sessionName,
        ...Object.fromEntries(["model", "modelConfig", "modelProfile"].map((name) => [name, source[name]])), continuationHandle: source.handle,
        noProgressMs: 15000 }).task_id;
      const active = internal("active", "wait for cancellation", "g");
      // 只此隔离测试通过内部原语派发排队请求，公开 submit 始终删除。
      const runInternal = (id) => {
        const child = spawn(path.join(root, "bin/opencode-task"), ["_run", id], { env, cwd: base, stdio: "ignore" });
        fs.appendFileSync(path.join(base, "drivers.ndjson"), JSON.stringify({ pid: child.pid, ticks: processBirth(child.pid).ticks, role: "_run", taskId: id }) + "\n");
        return child;
      };
      runInternal(active); await until(() => load(active).startedAt, "active original");
      const cancelled = internal("queued-cancel", "continuity", "h"), survivor = internal("queued-survivor", "continuity", "i");
      runInternal(cancelled); runInternal(survivor);
      await until(() => load(cancelled).dispatchedAt && load(survivor).dispatchedAt, "two requests queued");
      checked(["cancel", cancelled]);
      await until(() => load(cancelled).result?.status === "cancelled", "queued canonical cancel");
      assert.equal(load(active).result, undefined); assert.equal(load(survivor).result, undefined);
      checked(["cancel", active]);
      await until(() => load(survivor).result?.status === "success", "other queued survived");

      // 两个公开 launch 竞争同一 key；整个准备/提交链只有一个提交者。
      const concurrent = input("concurrent", "continuity", "j"), file = inputFile(concurrent);
      const call = () => new Promise((resolve, reject) => {
        const child = spawn(path.join(root, "bin/opencode-task"), ["launch", "--input-file", file], { cwd: base, env });
        let out = "", err = ""; child.stdout.on("data", (data) => { out += data; }); child.stderr.on("data", (data) => { err += data; });
        child.once("error", reject); child.once("close", (status) => { assert.equal(status, 0, err); resolve(JSON.parse(out)); });
      });
      const results = await Promise.all([call(), call()]); assert.equal(results[0].request_id, results[1].request_id);
      await until(() => load(results[0].task_id).result, "concurrent completed");
      assert.equal(lines(env.TASK_FIXTURE_EVENT_LOG).filter((event) => event.type === "prompt_received" &&
        event.sessionId === load(results[0].task_id).handle.backendSessionId).length, 1);
      for (const command of ["submit", "resolve", "inspect"]) assert.equal(cli([command]).status, 1);
      const unknown = path.join(root, "runtime/tasks", "task_" + "f".repeat(64)); fs.mkdirSync(unknown, { mode: 0o700 });
      write(path.join(unknown, "task.json"), { version: 1, id: path.basename(unknown) });
      const old = fs.readFileSync(path.join(unknown, "task.json"));
      assert.equal(checked(["recover"]).unsupported.length, 1);
      assert.deepEqual(fs.readFileSync(path.join(unknown, "task.json")), old);
      t.diagnostic(JSON.stringify({ launches: results.length, stable_custom_controls_per_task: 1, callbacks: receipts.size,
        late_callback_body_unchanged: true, recover_replayed_prompts: 0, cancel_queued_isolated: true }));
    } catch (error) { primaryError = error; t.diagnostic(`retained fixture: ${base}`); }
    await finishFixture(primaryError, async () => {
      await stopFixtureProcesses(base, version); webhook.closeAllConnections(); await new Promise((resolve) => webhook.close(resolve));
      if (!primaryError) fs.rmSync(base, { recursive: true });
    }, (value) => t.diagnostic(JSON.stringify(value)));
  });

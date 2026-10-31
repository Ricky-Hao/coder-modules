import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { TaskRunner } from "../scripts/task.mjs";
import { startHealthWitness, stopFixtureProcesses, finishFixture, recordFixtureSpawns, fixtureProcessSnapshot } from "./cli-fixture.mjs";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "actual wrapper/CLI: detached submit, private stdin, lost receipt/worker restart, dedupe and status",
  { timeout: 120000 },
  async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "module-cli-"));
    fs.chmodSync(base, 0o700);
    const root = path.join(base, "toolset");
    const version = path.join(root, "versions/fixture");
    fs.mkdirSync(version, { recursive: true, mode: 0o700 });
    for (const dir of [root, path.join(root, "versions"), version])
      fs.chmodSync(dir, 0o700);
    for (const name of [
      "runtime.py",
      "diagnostics.py",
      "safety.py",
      "profiles.py",
      "profile-env.json",
      "task.mjs",
      "task-read.mjs",
      "task-launch.mjs",
      "task-cli.mjs",
      "task-acp.mjs",
      "task-supervisor.mjs",
    ])
      fs.copyFileSync(path.join(scripts, name), path.join(version, name));
    // Only this synthetic fixture may expose diagnostics from its copied worker.
    const copiedCli = path.join(version, 'task-cli.mjs');
    fs.writeFileSync(copiedCli, fs.readFileSync(copiedCli, 'utf8').replace(
      '} catch (error) {\n  // 仅输出安全码。', `} catch (error) {\n  fs.appendFileSync(${JSON.stringify(path.join(base, 'worker-errors'))}, error.stack + '\\n');\n  // 仅输出安全码。`).replace(
      'const stored = runner.load(id);', `const stored = runner.load(id);\n      if (['_worker', '_observe', '_supervise', '_fail_launch'].includes(command)) {
        process.on('uncaughtExceptionMonitor', (error) => {
          try { fs.appendFileSync(${JSON.stringify(path.join(base, 'driver-errors.ndjson'))}, JSON.stringify({
            pid: process.pid, role: command, taskId: id, code: error.code, message: error.message,
            stack: error.stack, at: Date.now() }) + '\\n'); }
          catch { /* 仅记录未捕获异常，不拦截默认退出。 */ }
        });
        fs.appendFileSync(${JSON.stringify(path.join(base, 'drivers.ndjson'))}, JSON.stringify({ pid: process.pid,
          ticks: fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).trim().split(/\\s+/)[19], role: command, taskId: id }) + '\\n');
        process.once('exit', (code) => {
          try { fs.appendFileSync(${JSON.stringify(path.join(base, 'driver-exits.ndjson'))},
            JSON.stringify({ pid: process.pid, role: command, taskId: id, code, at: Date.now() }) + '\\n'); }
          catch { /* 诊断不可改变复制 driver 的退出结果。 */ }
        });
        fs.writeFileSync(${JSON.stringify(base)} + '/' + (command === '_supervise' ? 'monitor' : 'worker') + '-' + id + '.pid', String(process.pid));
      }`));
    for (const name of ['task-cli.mjs', 'task-supervisor.mjs']) {
      const copied = path.join(version, name);
      fs.writeFileSync(copied, recordFixtureSpawns(fs.readFileSync(copied, 'utf8'), path.join(base, 'drivers.ndjson')));
    }
    const heartbeatFaults = path.join(base, 'heartbeat-read-faults');
    fs.mkdirSync(heartbeatFaults, { mode: 0o700 });
    const copiedSupervisor = path.join(version, 'task-supervisor.mjs');
    const readerMarker = 'export function readWorkerHeartbeat(filename) {';
    const supervisorSource = fs.readFileSync(copiedSupervisor, 'utf8');
    assert.ok(supervisorSource.includes(readerMarker));
    fs.writeFileSync(copiedSupervisor, supervisorSource.replace(readerMarker, `${readerMarker}
  const taskId = filename.split('/').at(-2);
  const fault = ${JSON.stringify(heartbeatFaults)} + '/' + taskId;
  if (fs.existsSync(fault)) {
    const mode = fs.readFileSync(fault, 'utf8');
    if (mode === 'once') fs.unlinkSync(fault);
    fs.appendFileSync(${JSON.stringify(path.join(base, 'heartbeat-read-errors.ndjson'))},
      JSON.stringify({ taskId, pid: process.pid, mode, at: Date.now() }) + '\\n');
    throw Object.assign(new Error('synthetic heartbeat read failure'), { code: 'EACCES' });
  }`));
    fs.mkdirSync(path.join(version, "node/bin"), {
      recursive: true,
      mode: 0o700,
    });
    fs.copyFileSync(
      process.env.NODE_FIXTURE_BINARY ?? process.execPath,
      path.join(version, "node/bin/node"),
    );
    fs.cpSync(
      path.join(scripts, "node_modules"),
      path.join(version, "node_modules"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(root, "bin"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "runtime"), { mode: 0o700 });
    for (const name of ["home", "config", "data", "cache", "state", "tmp"])
      fs.mkdirSync(path.join(root, "runtime", name), { mode: 0o700 });
    fs.writeFileSync(
      path.join(root, "owner.json"),
      JSON.stringify({
        schema: 1,
        uid: process.getuid(),
        workspace_id: "cli-fixture",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(version, "settings.json"),
      JSON.stringify({
        install_root: root,
        workspace_id: "cli-fixture",
        runtime_profile: "env",
      }),
      { mode: 0o600 },
    );
    fs.symlinkSync("versions/fixture", path.join(root, "active"));
    const pidfile = (id) => path.join(base, `worker-${id}.pid`);
    for (const tool of ["opencode", "opencode-task"]) {
      const pid =
        tool === "opencode-task"
           ? `if [[ "\${1-}" == _worker ]]; then printf '%s' "$$" > ${quote(base)}/worker-\${2}.pid; exec 2>>${quote(path.join(base, 'worker-errors'))}; fi\n`
           : "";
      const birth = tool === "opencode-task" ? `case "\${1-}" in _worker|_observe|_supervise|_fail_launch)
read -r fixture_stat < /proc/$$/stat
fixture_stat=\${fixture_stat##*) }
read -ra fixture_fields <<< "$fixture_stat"
printf '{"pid":%s,"ticks":"%s","role":"%s"}\\n' "$$" "\${fixture_fields[19]}" "$1" >> ${quote(path.join(base, 'drivers.ndjson'))}
esac
` : "";
      fs.writeFileSync(
        path.join(root, "bin", tool),
        `#!/usr/bin/env bash\nset -euo pipefail\n${birth}${pid}exec python3 -B ${quote(path.join(root, "active/runtime.py"))} ${tool} "$@"\n`,
        { mode: 0o700 },
      );
    }
    const fixturePeer = fileURLToPath(
      new URL("./acp.fixture.mjs", import.meta.url),
    );
    fs.writeFileSync(
      path.join(version, "opencode"),
      `#!/usr/bin/env bash\nexec ${quote(path.join(version, "node/bin/node"))} ${quote(fixturePeer)} "$@"\n`,
      { mode: 0o700 },
    );
    fs.mkdirSync(path.join(root, "runtime/home/.acpx"), { mode: 0o700 });
    fs.writeFileSync(
      path.join(root, "runtime/home/.acpx/config.json"),
      JSON.stringify({
        defaultAgent: "opencode",
        defaultPermissions: "deny-all",
        nonInteractivePermissions: "deny",
        authPolicy: "skip",
        agents: {
          opencode: { argv: [path.join(root, "bin/opencode"), "acp"] },
        },
      }),
      { mode: 0o600 },
    );
    const executions = path.join(base, "executions");
    const eventLog = path.join(base, "events.ndjson");
    const progressControl = path.join(base, "progress-control");
    fs.mkdirSync(progressControl, { mode: 0o700 });
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: base,
      OPENCODE_ACP_REQUIRED_MODEL: "fixture/test",
      TASK_FIXTURE_LOG: executions,
      TASK_FIXTURE_CONTROL_LOG: path.join(base, 'controls'),
      TASK_FIXTURE_PROCESS_LOG: path.join(base, 'processes'),
      TASK_FIXTURE_EVENT_LOG: eventLog, TASK_FIXTURE_PROGRESS_CONTROL: progressControl,
      TASK_FIXTURE_ENV_CHECK: '1',
      HTTP_PROXY: 'http://proxy.example.invalid:8080',
      https_proxy: 'http://proxy.example.invalid:8443',
      ALL_PROXY: 'socks5://proxy.example.invalid:1080', NO_PROXY: 'localhost,127.0.0.1',
      UNLISTED_SERVICE_CREDENTIAL: 'synthetic-custom-auth', UNLISTED_SETTING: 'arbitrary value 值',
      ANTHROPIC_API_KEY: 'synthetic-other-provider', LLM_API_KEY: 'synthetic-legacy-key',
      FIRECRAWL_MCP_ENABLED: '0', FIRECRAWL_MCP_API_KEY: 'synthetic-disabled-mcp',
      FIRECRAWL_MCP_URL: 'ignored invalid endpoint while disabled', LC_ALL: 'C.UTF-8',
      LC_TASK_CALLBACK_URL: 'https://private.example.invalid/api/agents/task-callbacks',
      OPENCODE_TASK_CALLBACK_CONTROL: 'private-protocol-field',
      UNLISTED_CALLBACK_BEARER: `Bearer tcb_${'e'.repeat(43)}`,
      CODEX_BASE_URL: 'https://codex.example.invalid/v1', CODEX_API_KEY: 'synthetic-codex',
      COPILOT_BASE_URL: 'https://copilot.example.invalid/v1', COPILOT_API_KEY: 'synthetic-copilot',
      OPENCODE_TASK_POLL_MS: '100', OPENCODE_TASK_PROBE_MS: '1000', OPENCODE_TASK_DISCOVERY_MS: '5000',
      OPENCODE_TASK_WORKER_MS: '5000', OPENCODE_TASK_SETUP_MS: '15000', OPENCODE_TASK_PROGRESS_MS: '10000',
      OPENCODE_TASK_DRAIN_MS: '30', OPENCODE_TASK_CONFIRM_MS: '600',
    };
    const cli = (args, input) =>
      spawnSync(path.join(root, "bin/opencode-task"), args, {
        cwd: base,
        env,
        input,
        encoding: "utf8",
        timeout: 5000,
      });
    const seen = [];
    const receipts = new Map();
    const httpAttempts = [];
    let interruptCallback;
    const webhook = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        seen.push(data);
        const id = JSON.parse(data).callback_id;
        // 本地 receiver 先记录接收，再模拟首 receipt 丢失；同 id/body 只接收一次。
        if (!receipts.has(id)) receipts.set(id, { body: data, receipt: {
          version: 1, receipt_id: "durable-fixture", accepted_at: new Date().toISOString(),
        } });
        assert.equal(data, receipts.get(id).body);
        const dropped = seen.length === 1 || interruptCallback?.(data);
        httpAttempts.push({ id, at: Date.now(), status: dropped ? null : 202 });
        if (dropped) req.socket.destroy();
        else {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify(receipts.get(id).receipt));
        }
      });
    });
    await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    let taskId;
    let primaryError;
    let phase = "initial-submit";
    const witnesses = [];
    try {
      const callbackId = `tcb_${"z".repeat(43)}`;
      const registration = JSON.stringify({
        callback_id: callbackId,
        callback_url: `http://127.0.0.1:${webhook.address().port}/api/agents/task-callbacks`,
      });
      fs.writeFileSync(
        path.join(base, "prompt.txt"),
        "Produce one final response.",
      );
      const submitArgs = [
        "submit",
        "--key",
        "same-local-key",
        "--prompt-file",
        path.join(base, "prompt.txt"),
      ];
      const start = Date.now();
      const submitted = cli(submitArgs, registration);
      assert.equal(submitted.status, 0, submitted.stderr);
      assert.ok(Date.now() - start < 2000);
      const accepted = JSON.parse(submitted.stdout);
      taskId = accepted.task_id;
      assert.equal(accepted.accepted, true);
      assert.equal(submitted.stdout.includes(callbackId), false);
      const deadline = Date.now() + 15000;
      while (seen.length < 1 && Date.now() < deadline) await pause(50);
      assert.equal(seen.length, 1, JSON.stringify({
        state: JSON.parse(fs.readFileSync(path.join(root, 'runtime/tasks', taskId, 'task.json'), 'utf8')).state,
        workerError: fs.existsSync(path.join(base, 'worker-errors')) ? fs.readFileSync(path.join(base, 'worker-errors'), 'utf8') : '',
      }));
      const monitorPid = Number(fs.readFileSync(path.join(base, `monitor-${taskId}.pid`), "utf8"));
      process.kill(monitorPid, "SIGKILL");
      await pause(100);
      const recovering = cli(["recover"]);
      assert.equal(recovering.status, 0, recovering.stderr);
      let state;
      while (Date.now() < deadline) {
        const status = cli(["status", taskId]);
        assert.equal(status.status, 0, status.stderr);
        assert.equal(status.stdout.includes(callbackId), false);
        state = JSON.parse(status.stdout).state;
        if (state === "delivered") break;
        await pause(100);
      }
      assert.equal(state, "delivered");
      assert.equal(seen.length, 2);
      assert.equal(seen[0], seen[1]);
      const taskFile = path.join(root, "runtime/tasks", taskId, "task.json");
      const beforeRead = fs.readFileSync(taskFile);
      const readerCli = (args) => spawnSync(path.join(root, "bin/opencode-task"), args, {
        cwd: base,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: base },
        encoding: "utf8",
        timeout: 5000,
      });
      const result = readerCli(["result", taskId]);
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.task_id, taskId);
      assert.equal(summary.request_id, accepted.request_id);
      assert.equal(summary.state, "delivered");
      assert.equal(summary.result_status, "success");
      assert.equal(summary.output, "Pinned ACP result");
      assert.equal(summary.output_truncated, false);
      assert.equal(summary.evidence.terminal_source, "turn.result");
      assert.equal(summary.evidence.output_source, "assistant_output");
      assert.ok(Number.isSafeInteger(summary.timing.accepted_at));
      assert.ok(summary.timing.started_at >= summary.timing.accepted_at);
      assert.ok(summary.timing.terminal_at >= summary.timing.started_at);
      assert.ok(summary.timing.callback_attempted_at >= summary.timing.terminal_at);
      assert.ok(summary.timing.callback_delivered_at >= summary.timing.callback_attempted_at);
      assert.equal(result.stdout.includes(callbackId), false);
      assert.equal(result.stdout.includes("Produce one final response."), false);
      assert.equal(result.stdout.includes(JSON.parse(registration).callback_url), false);
      assert.deepEqual(fs.readFileSync(taskFile), beforeRead);
      const safeStatus = JSON.parse(readerCli(["status", taskId]).stdout);
      assert.equal(JSON.stringify(safeStatus).includes(callbackId), false);
      assert.equal(JSON.stringify(safeStatus).includes("Produce one final response."), false);
      assert.equal(JSON.stringify(safeStatus).includes(summary.output), false);
      assert.equal(readerCli(["result", taskId, "--unexpected"]).status, 1);
      fs.writeFileSync(taskFile, JSON.stringify({ ...JSON.parse(beforeRead),
        body: callbackId }), { mode: 0o600 });
      const malformed = readerCli(["result", taskId]);
      assert.equal(malformed.status, 1);
      assert.equal(malformed.stdout, "");
      assert.equal(malformed.stderr.includes(callbackId), false);
      assert.equal(malformed.stderr.includes("Produce one final response."), false);
      fs.writeFileSync(taskFile, beforeRead);
      const replay = cli(submitArgs, registration);
      assert.equal(replay.status, 0, replay.stderr);
      assert.deepEqual(JSON.parse(replay.stdout), accepted);
      assert.equal(fs.readFileSync(executions, "utf8"), "prompt\n");
      const stored = JSON.parse(
        fs.readFileSync(
          path.join(root, "runtime/tasks", taskId, "task.json"),
          "utf8",
        ),
      );
      assert.equal(stored.resultStatus, 'success');
      assert.equal(JSON.parse(stored.body).output, 'Pinned ACP result');
      assert.equal(stored.requestId, accepted.request_id);
      assert.equal(summary.session_id, stored.handle.backendSessionId ?? null);
      assert.equal(summary.acpx_record_id, stored.handle.acpxRecordId);
      const load = (id) =>
        JSON.parse(
          fs.readFileSync(
            path.join(root, "runtime/tasks", id, "task.json"),
            "utf8",
          ),
        );
      const until = async (condition, label = "condition") => {
        phase = label;
        const end = Date.now() + 10000;
        while (!condition()) {
          if (Date.now() > end) {
            const tasks = fs.readdirSync(path.join(root, 'runtime/tasks')).filter((name) => /^task_[a-f0-9]{64}$/.test(name))
              .map((id) => { const { state, executionError, health, workerExit } = load(id); return { id, state, executionError, health, workerExit }; });
            throw new Error(JSON.stringify({ message: 'CLI fixture timed out', label, tasks,
              fixtureErrors: fs.existsSync(path.join(base, 'worker-errors')) ? fs.readFileSync(path.join(base, 'worker-errors'), 'utf8') : '' }));
          }
          await pause(40);
        }
      };
      const submit = (key, prompt, flags = []) => {
        const promptFile = path.join(base, `${key}.txt`);
        fs.writeFileSync(promptFile, prompt);
        const callback = {
          callback_id: `tcb_${key.padEnd(43, "q").slice(0, 43)}`,
          callback_url: JSON.parse(registration).callback_url,
        };
        const result = cli(
          [
            "submit",
            "--key",
            key,
            "--prompt-file",
            promptFile,
            "--session",
            "review-branch",
            ...flags,
          ],
          JSON.stringify(callback),
        );
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout).task_id;
      };
      const delivered = async (id) => {
        try { await until(() => load(id).state === "delivered", `delivered:${id}`); }
        catch (error) {
          try {
            const { state, executionError, health, workerExit } = load(id);
            const observations = Object.fromEntries(['worker.json', 'monitor.json'].map((name) => {
              const file = path.join(root, 'runtime/tasks', id, name);
              return [name, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null];
            }));
            const record = load(id);
            const journal = record.handle ? path.join(root, 'runtime/home/.acpx/sessions',
              `${encodeURIComponent(record.handle.acpxRecordId)}.stream.ndjson`) : null;
            const journalTerminals = journal && fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').slice(0, -1)
              .map(JSON.parse).filter((event) => ['turn_started', 'turn_result'].includes(event.type))
              .map((event) => ({ type: event.type, request_id: event.request_id, status: event.result?.status,
                detail_code: event.result?.error?.detailCode })) : [];
            console.error(JSON.stringify({ phase: `delivered:${id}`, state, executionError, health, workerExit,
              now: Date.now(), request_id: record.requestId, cursor: record.cursor, journalTerminals,
              processes: fixtureProcessSnapshot(base), observations,
              exits: fs.existsSync(path.join(base, 'driver-exits.ndjson')) ?
                fs.readFileSync(path.join(base, 'driver-exits.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).filter((value) => value.taskId === id) : [],
              fixtureErrors: fs.existsSync(path.join(base, 'worker-errors')) ? fs.readFileSync(path.join(base, 'worker-errors'), 'utf8') : '' }));
          } catch { /* 诊断读取损坏也须重抛进入 catch 的原错误。 */ }
          throw error;
        }
        return load(id);
      };
      const denied = submit("default-write", "write fixture");
      const deniedRecord = await delivered(denied);
      assert.match(
        JSON.parse(deniedRecord.body).output,
        /Write denied; turn 1/,
      );
      assert.equal(
        fs.existsSync(path.join(base, "authorized-write.txt")),
        false,
      );
      assert.equal(deniedRecord.permissions.mode, "deny-all");
      const authorized = submit("authorized-write", "write fixture then wait", [
        "--permission-mode",
        "approve-all",
      ]);
      await until(
        () =>
          fs.existsSync(path.join(base, "authorized-write.txt")) &&
          load(authorized).state === "running",
      );
      assert.equal(
        fs.readFileSync(path.join(base, "authorized-write.txt"), "utf8"),
        "turn 2",
      );
      // Crash only our detached driver; the original ACP request continues.
      process.kill(
        Number(fs.readFileSync(pidfile(authorized), "utf8")),
        "SIGKILL",
      );
      await pause(80);
      // Its monitor must recover this lost driver without an operator recover call.
      const authorizedRecord = await delivered(authorized);
      assert.match(
        JSON.parse(authorizedRecord.body).output,
        /Write permitted; turn 2/,
      );
      assert.equal(authorizedRecord.permissions.mode, "approve-all");
      assert.equal(
        authorizedRecord.handle.acpxRecordId,
        deniedRecord.handle.acpxRecordId,
      );
      assert.equal(
        authorizedRecord.handle.backendSessionId,
        deniedRecord.handle.backendSessionId,
      );
      assert.notEqual(authorizedRecord.requestId, deniedRecord.requestId);
      const conservative = await delivered(
        submit("default-again", "write fixture"),
      );
      assert.match(
        JSON.parse(conservative.body).output,
        /Write denied; turn 3/,
      );
      assert.equal(
        fs.readFileSync(path.join(base, "authorized-write.txt"), "utf8"),
        "turn 2",
      );
      const policyFile = path.join(base, "policy.json");
      fs.writeFileSync(policyFile, JSON.stringify({ autoDeny: ["edit"] }), {
        mode: 0o600,
      });
      const policyRecord = await delivered(
        submit("explicit-policy", "write fixture", [
          "--permission-mode",
          "approve-all",
          "--permission-policy-file",
          policyFile,
        ]),
      );
      assert.match(
        JSON.parse(policyRecord.body).output,
        /Write denied; turn 4/,
      );
      assert.deepEqual(policyRecord.permissions.policy, { autoDeny: ["edit"] });
      const continuity = await delivered(
        submit("review-followup", "continuity"),
      );
      assert.match(JSON.parse(continuity.body).output, /Session turn 5/);
      assert.equal(
        continuity.handle.backendSessionId,
        authorizedRecord.handle.backendSessionId,
      );
      const waiting = submit("active-request", "wait for cancellation");
      await until(() => load(waiting).state === "running");
      const cancelledQueued = submit("cancelled-queued", "continuity");
      await until(() => load(cancelledQueued).state === "dispatching");
      assert.equal(cli(["cancel", cancelledQueued]).status, 0);
      assert.equal(
        (await delivered(cancelledQueued)).resultStatus,
        "cancelled",
      );
      assert.equal(load(waiting).state, "running");
      const queued = submit("queued-request", "continuity");
      await until(() => load(queued).state === "dispatching");
      await pause(200);
      // Recovery/cancel has no in-process turn object and must target A,
      // while the unrelated queued follow-up Q continues normally.
      process.kill(
        Number(fs.readFileSync(path.join(base, `monitor-${waiting}.pid`), "utf8")),
        "SIGKILL",
      );
      await pause(80);
      assert.equal(cli(["cancel", waiting]).status, 0);
      assert.equal(cli(["recover"]).status, 0);
      const queuedResult = await delivered(queued);
      assert.equal(queuedResult.resultStatus, "success");
      assert.match(JSON.parse(queuedResult.body).output, /Session turn 7/);
      assert.equal((await delivered(waiting)).resultStatus, "cancelled");
      assert.equal(cli(["cancel", waiting]).status, 1);
      const afterCancel = await delivered(submit("after-cancel", "continuity"));
      assert.match(JSON.parse(afterCancel.body).output, /Session turn 8/);
      const notifications = new Map();
      for (const item of seen.slice(2)) {
        const id = JSON.parse(item).callback_id;
        notifications.set(id, (notifications.get(id) ?? 0) + 1);
      }
      assert.equal(notifications.size, 9);
      assert.ok([...notifications.values()].every((count) => count === 1));
      assert.equal(
        fs.readFileSync(executions, "utf8").trim().split("\n").length,
        9,
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(
            path.join(root, "runtime/home/.acpx/config.json"),
            "utf8",
          ),
        ).defaultPermissions,
        "deny-all",
      );
      // Each session selects only once; queued/follow-up workers send no model controls.
      assert.equal(fs.readFileSync(path.join(base, 'controls'), 'utf8'), 'model\nmodel\n');
      const modelFile = path.join(base, 'model.txt');
      fs.writeFileSync(modelFile, 'model selection');
      const registrationFor = (letter) => JSON.stringify({ callback_id: `tcb_${letter.repeat(43)}`,
        callback_url: JSON.parse(registration).callback_url });
      const modelArgs = ['submit', '--key', 'copilot-model', '--session', 'copilot-session', '--prompt-file', modelFile,
        '--model', 'copilot/gpt-6-astra', '--variant', 'high'];
      const chosen = JSON.parse(cli(modelArgs, registrationFor('c')).stdout);
      const chosenRecord = await delivered(chosen.task_id);
      const selection = JSON.parse(JSON.parse(chosenRecord.body).output);
      assert.equal(selection.model, 'copilot/gpt-6-astra'); assert.equal(selection.effort, 'high');
      assert.deepEqual(selection.title, { providerID: 'copilot', model: 'gpt-6.1-sol', variant: 'low' });
      assert.deepEqual(selection.env, ['CODEX_API_KEY', 'COPILOT_API_KEY']);
      assert.equal(selection.inheritedEnvironment, true);
      assert.deepEqual(JSON.parse(cli(['status', chosen.task_id]).stdout).model, 'copilot/gpt-6-astra');
      assert.equal(JSON.parse(cli(['status', chosen.task_id]).stdout).variant, 'high');
      assert.equal(cli([...modelArgs.slice(0, -1), 'max'], registrationFor('c')).status, 1);
      assert.equal(cli(['submit', '--key', 'conflicting-provider', '--session', 'copilot-session', '--prompt-file', modelFile], registrationFor('d')).status, 1);
      assert.deepEqual(JSON.parse(cli(modelArgs, registrationFor('c')).stdout), chosen);
      const beforeRefusal = fs.readFileSync(executions, 'utf8');
      env.TASK_FIXTURE_REFUSE_MODEL = 'copilot/gpt-6.1-sol';
      const refused = JSON.parse(cli(['submit', '--key', 'refused-model', '--prompt-file', modelFile,
        '--model', 'copilot/gpt-6.1-sol'], registrationFor('f')).stdout);
      await delivered(refused.task_id);
      assert.equal(fs.readFileSync(executions, 'utf8'), beforeRefusal);
      assert.equal(load(refused.task_id).state, 'delivered');
      assert.equal(load(refused.task_id).resultStatus, 'error');
      assert.equal(cli(['cancel', refused.task_id]).status, 1);
      delete env.TASK_FIXTURE_REFUSE_MODEL;
      const faultSubmit = (key, prompt, flags = []) => {
        fs.writeFileSync(modelFile, prompt);
        const result = cli(['submit', '--key', key, '--prompt-file', modelFile, ...flags],
          JSON.stringify({ callback_id: `tcb_${key.padEnd(43, 'v')}`, callback_url: JSON.parse(registration).callback_url }));
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout).task_id;
      };
      const failed = await delivered(faultSubmit('provider-failed', 'provider failed'));
      assert.equal(failed.resultStatus, 'error');
      assert.equal(failed.executionError, 'REQUEST_FAILED');
      assert.equal(failed.terminalSource, 'watchSession.turn_result');
      assert.equal(failed.body.includes('synthetic provider.internal'), false);
      const exited = await delivered(faultSubmit('agent-exit', 'agent exit'));
      assert.equal(exited.resultStatus, 'error');
      assert.equal(exited.terminalSource, 'watchSession.turn_result');
      env.OPENCODE_TASK_PROGRESS_MS = '500';
      env.OPENCODE_TASK_TOOL_MS = '5000';
      const healthyToolId = `task_${createHash('sha256').update('healthy-tool').digest('hex')}`;
      fs.writeFileSync(path.join(heartbeatFaults, healthyToolId), 'once');
      const toolBegan = Date.now();
      const slow = await delivered(faultSubmit('healthy-tool', 'long tool'));
      assert.equal(slow.resultStatus, 'success');
      assert.equal(JSON.parse(slow.body).output, 'Slow tool completed');
      assert.equal(fs.readFileSync(path.join(base, 'heartbeat-read-errors.ndjson'), 'utf8').trim().split('\n')
        .map(JSON.parse).filter((event) => event.taskId === healthyToolId).length, 1);
      assert.equal(new Set(fs.readFileSync(path.join(base, 'drivers.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
        .filter((event) => event.taskId === healthyToolId && ['_worker', '_observe'].includes(event.role)).map((event) => event.pid)).size, 1);
      t.diagnostic(JSON.stringify({ scenario: 'healthy-tool', progress_ms: 500, confirm_ms: 600, tool_ms: 5000,
        heartbeat_read_errors: 1, driver_attempts: 1, elapsed_ms: Date.now() - toolBegan, result_status: slow.resultStatus }));

      // 真实 detached worker/monitor 自动完成判断、封存和 HTTP 投递，测试只读任务文件。
      env.OPENCODE_TASK_PROGRESS_MS = '600';
      env.OPENCODE_TASK_CONFIRM_MS = '800';
      const lines = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : [];
      const peerEvents = (record) => lines(eventLog).filter((event) => event.sessionId === record.handle.backendSessionId);
      const journalEntries = (record) => lines(path.join(root, 'runtime/home/.acpx/sessions',
        `${encodeURIComponent(record.handle.acpxRecordId)}.stream.ndjson`)); // pinned acpx，只读合成 journal。
      const executionCount = () => fs.readFileSync(executions, 'utf8').trim().split('\n').length;
      const callbacks = (record) => seen.filter((body) => JSON.parse(body).callback_id === record.callback.callback_id);
      const witnessFor = async (key, resumeDirectory) => {
        const id = `task_${createHash('sha256').update(key).digest('hex')}`;
        const witness = await startHealthWitness(path.join(root, 'runtime/tasks', id, 'task.json'), resumeDirectory);
        witnesses.push(witness);
        return witness;
      };
      phase = "thought-health-control";
      console.error(JSON.stringify({ fixture_phase: phase, at: Date.now() }));
      const thoughtWitness = await witnessFor('healthy-thought', progressControl);
      const beforeHealthControls = executionCount();
      const thoughtId = faultSubmit('healthy-thought', 'recover thought progress');
      await until(() => {
        const record = load(thoughtId);
        return record.handle && peerEvents(record).some((event) => event.type === 'thought_ready');
      }, 'thought peer ready before blocking');
      const thoughtSession = load(thoughtId).handle.backendSessionId;
      // 子进程先触发静默，父线程已阻塞。以真实怀疑时间确认阻塞覆盖整个 confirm 窗口。
      const blockStartedAt = Date.now();
      const blockTick = performance.now();
      const blocked = spawnSync('python3', ['-B', '-c', `import json, pathlib, sys, time
control = pathlib.Path(sys.argv[1])
control.with_name(control.name + '.quiet').write_text('inject synthetic silence')
started = time.monotonic()
while True:
    evidence = control.with_name(control.name + '.suspected.json')
    if evidence.exists() and time.monotonic() - started >= 1.8:
        suspected = json.loads(evidence.read_text())['suspectedAt']
        if time.time() * 1000 >= suspected + 800: break
    if time.monotonic() - started > 4: raise RuntimeError('thought blocking evidence timed out')
    time.sleep(0.01)
`, path.join(progressControl, thoughtSession)], { env: { PATH: env.PATH }, timeout: 5000 });
      const blockEndedAt = Date.now();
      const parentBlockedMs = performance.now() - blockTick;
      assert.equal(blocked.status, 0, blocked.stderr?.toString());
      await until(() => thoughtWitness.events.suspected || thoughtWitness.events.error || thoughtWitness.events.sealed, 'thought enters suspicion');
      assert.equal(thoughtWitness.events.error, undefined);
      const quietThought = thoughtWitness.events.suspected;
      assert.ok(quietThought, JSON.stringify(thoughtWitness.events));
      const quietStartedAt = peerEvents(load(thoughtId)).find((event) => event.type === 'quiet_started').at;
      assert.ok(quietStartedAt >= blockStartedAt && quietStartedAt <= blockEndedAt);
      assert.ok(quietThought.health.suspectedAt >= quietStartedAt);
      assert.ok(blockEndedAt - quietThought.health.suspectedAt >= 800);
      assert.equal(quietThought.health.suspectedReason, 'PROGRESS_UNCONFIRMED');
      assert.equal(quietThought.health.ownerProcess, 'alive');
      assert.equal(quietThought.bodyPresent, false);
      assert.equal(quietThought.assistantOutput, false);
      await until(() => thoughtWitness.events.resumed || thoughtWitness.events.error || thoughtWitness.events.sealed, 'thought retracts suspicion');
      const resumedThought = thoughtWitness.events.resumed;
      assert.ok(resumedThought, JSON.stringify(thoughtWitness.events));
      assert.equal(resumedThought.health.suspectedAt, undefined);
      assert.equal(resumedThought.health.suspectedReason, undefined);
      assert.equal(resumedThought.bodyPresent, false);
      assert.equal(resumedThought.assistantOutput, false);
      assert.equal(callbacks(load(thoughtId)).length, 0);
      // peer 持续 thought，直到父测试确认健康跨度后显式放行终态，避免错过 observing 窗口。
      await until(() => {
        const event = peerEvents(load(thoughtId)).find((item) => item.type === 'thought_resumed');
        return event && Date.now() - event.at >= 1600;
      }, 'thought stays healthy beyond progress and confirmation');
      fs.writeFileSync(path.join(progressControl, `${quietThought.sessionId}.finish`), 'finish synthetic thought');
      const thought = await delivered(thoughtId);
      await thoughtWitness.close();
      assert.equal(thought.resultStatus, 'success');
      assert.equal(JSON.parse(thought.body).output, '');
      assert.equal(callbacks(thought).length, 1);
      assert.equal(thought.notificationKind, undefined);
      assert.equal(executionCount(), beforeHealthControls + 1);
      const thoughtJournal = journalEntries(thought);
      assert.equal(thoughtJournal.filter((event) => event.type === 'turn_started' && event.request_id === thought.requestId).length, 1);
      assert.equal(thoughtJournal.filter((event) => event.type === 'turn_result' && event.request_id === thought.requestId).length, 1);
      assert.equal(thoughtJournal.some((event) => event.params?.update?.sessionUpdate === 'agent_message_chunk'), false);
      const thoughtUpdates = thoughtJournal.filter((event) => event.params?.update?.sessionUpdate === 'agent_thought_chunk');
      assert.ok(thoughtUpdates.length >= 5);
      const thoughtEvents = peerEvents(thought);
      const resumedAt = thoughtEvents.find((event) => event.type === 'thought_resumed').at;
      const completedAt = thoughtEvents.find((event) => event.type === 'thought_completed').at;
      assert.ok(completedAt - resumedAt > 600 + 800);
      t.diagnostic(JSON.stringify({ scenario: 'thought-after-suspicion', task_id: thoughtId, request_id: thought.requestId,
        suspected_at: quietThought.health.suspectedAt, resumed_at: resumedAt, completed_at: completedAt,
        cleared_at: resumedThought.health.observedAt, thought_events: thoughtUpdates.length,
        assistant_events: 0, parent_blocked_ms: parentBlockedMs, block_started_at: blockStartedAt,
        block_ended_at: blockEndedAt, quiet_started_at: quietStartedAt,
        business_executions: 1, http_posts: 1, result_status: 'success' }));

      const stalledCallback = `tcb_${'alive-stall'.padEnd(43, 'v')}`;
      let lostStallReceipt = false;
      interruptCallback = (body) => {
        if (JSON.parse(body).callback_id !== stalledCallback || lostStallReceipt) return false;
        lostStallReceipt = true;
        return true;
      };
      const beforeStall = executionCount();
      phase = 'alive-original-stall';
      console.error(JSON.stringify({ fixture_phase: phase, at: Date.now() }));
      const stallWitness = await witnessFor('alive-stall');
      const stalledId = faultSubmit('alive-stall', 'silent forever', ['--session', 'alive-stall-session']);
      await until(() => {
        const record = load(stalledId);
        // running 可先于 peer 消费请求；同时等到合成 peer 的接收证据。
        return record.state === 'running' && record.originalObserved &&
          peerEvents(record).some((event) => event.type === 'prompt_received');
      }, 'original received by peer before injecting silence');
      const startedStall = load(stalledId);
      assert.ok(journalEntries(startedStall).some((event) => event.type === 'turn_started' && event.request_id === startedStall.requestId));
      const originalPeer = peerEvents(startedStall).find((event) => event.type === 'prompt_received');
      assert.ok(originalPeer);
      const incarnation = lines(path.join(base, 'processes')).find((proof) => proof.agent === originalPeer.agent);
      assert.equal(incarnation.owner, originalPeer.owner);
      const assertOriginalAlive = (proof = incarnation) => {
        for (const [pid, ticks, command] of [[proof.agent, proof.startTicks, fixturePeer],
          [proof.owner, proof.ownerStartTicks, path.join(version, 'node_modules/acpx')]]) {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/);
          assert.equal(stat[19], ticks);
          assert.notEqual(stat[0], 'Z');
          assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(command));
          process.kill(pid, 0); // 只观察出生身份；检测完成前不发送终止/取消。
        }
      };
      assertOriginalAlive();
      // 同 session 的另一请求保持排队，卡死检测不得误取消或自动放行它。
      env.OPENCODE_TASK_PROGRESS_MS = '60000';
      const behindStall = faultSubmit('behind-stall', 'continuity', ['--session', 'alive-stall-session']);
      env.OPENCODE_TASK_PROGRESS_MS = '600';
      await until(() => load(behindStall).state === 'dispatching', 'unrelated same-session request queued');
      fs.writeFileSync(path.join(progressControl, `${startedStall.handle.backendSessionId}.stall`), 'inject permanent silence');
      await until(() => peerEvents(startedStall).some((event) => event.type === 'silent_started'), 'permanent silence injected');
      await until(() => stallWitness.events.suspected || stallWitness.events.error || stallWitness.events.sealed, 'silent original suspected');
      const suspectedStall = stallWitness.events.suspected;
      assert.ok(suspectedStall, JSON.stringify(stallWitness.events));
      assert.equal(suspectedStall.health.suspectedReason, 'PROGRESS_UNCONFIRMED');
      assert.equal(suspectedStall.health.owner, 'lease_current');
      assert.equal(suspectedStall.bodyPresent, false);
      assertOriginalAlive();
      await until(() => load(stalledId).notificationState === 'delivered', 'silent original automatic error receipt');
      const stalled = load(stalledId);
      await stallWitness.close();
      assertOriginalAlive();
      assert.equal(stalled.executionError, 'PROGRESS_UNCONFIRMED');
      assert.equal(stalled.state, 'ambiguous');
      assert.equal(stalled.health.assessment, 'unavailable');
      assert.equal(stalled.health.owner, 'lease_current');
      assert.equal(stalled.health.lastEventAt, suspectedStall.health.lastEventAt);
      assert.equal(stalled.cancelRequested, undefined);
      assert.equal(fs.existsSync(path.join(root, 'runtime/tasks', stalledId, 'cancel.json')), false);
      assert.equal(peerEvents(stalled).some((event) => event.type === 'cancel'), false);
      assert.equal(load(behindStall).state, 'dispatching');
      assert.equal(load(behindStall).handle.acpxRecordId, stalled.handle.acpxRecordId);
      assert.notEqual(load(behindStall).requestId, stalled.requestId);
      assert.equal(callbacks(load(behindStall)).length, 0);
      assert.equal(executionCount(), beforeStall + 1);
      const stalledJournal = journalEntries(stalled);
      assert.equal(stalledJournal.filter((event) => event.type === 'turn_started' && event.request_id === stalled.requestId).length, 1);
      assert.equal(stalledJournal.some((event) => event.type === 'turn_result' && event.request_id === stalled.requestId), false);
      assert.equal(stalledJournal.some((event) => event.type === 'turn_started' && event.request_id === load(behindStall).requestId), false);
      const stalledFile = path.join(root, 'runtime/tasks', stalledId, 'task.json');
      const beforeStallRead = fs.readFileSync(stalledFile);
      const stalledResult = readerCli(['result', stalledId]);
      assert.equal(stalledResult.status, 0, stalledResult.stderr);
      const safeStall = JSON.parse(stalledResult.stdout);
      assert.equal(safeStall.request_id, stalled.requestId);
      assert.equal(safeStall.callback_state, 'delivered');
      assert.equal(safeStall.callback_kind, 'supervision_failure');
      assert.equal(safeStall.callback_status, 'error');
      assert.equal(safeStall.result_status, null);
      assert.equal(safeStall.timing.terminal_at, null);
      assert.equal(safeStall.health.automatic_retry, false);
      assert.equal(safeStall.health.reason, 'PROGRESS_UNCONFIRMED');
      assert.equal(stalledResult.stdout.includes(stalledCallback), false);
      assert.equal(stalledResult.stdout.includes(JSON.parse(registration).callback_url), false);
      assert.equal(stalledResult.stdout.includes('silent forever'), false);
      const safeStallStatus = readerCli(['status', stalledId]);
      assert.equal(safeStallStatus.status, 0, safeStallStatus.stderr);
      assert.equal(JSON.parse(safeStallStatus.stdout).callback_state, 'delivered');
      assert.deepEqual(fs.readFileSync(stalledFile), beforeStallRead);
      assert.deepEqual(callbacks(stalled), [stalled.body, stalled.body]);
      assert.equal(lostStallReceipt, true);
      const payload = JSON.parse(stalled.body);
      assert.equal(payload.status, 'error');
      assert.match(payload.output, /outcome and side effects are unknown.*PROGRESS_UNCONFIRMED.*may still be running/);
      assert.deepEqual(stalled.receipt, receipts.get(stalledCallback).receipt);
      const attempts = httpAttempts.filter((attempt) => attempt.id === stalledCallback);
      assert.deepEqual(attempts.map((attempt) => attempt.status), [null, 202]);
      const policy = stalled.health.policy;
      const detectionBudget = policy.progressMs + policy.confirmMs + 2 * (policy.pollMs + policy.probeMs) + policy.probeMs;
      const detectionMs = attempts[0].at - stalled.health.lastEventAt;
      assert.ok(detectionMs >= policy.progressMs + policy.confirmMs, JSON.stringify({ detectionMs, policy }));
      assert.ok(detectionMs <= detectionBudget, JSON.stringify({ detectionMs, detectionBudget, policy }));
      assert.ok(stalled.supervisionFailedAt - suspectedStall.health.suspectedAt >= policy.confirmMs);
      assert.ok(stalled.callbackDeliveredAt - stalled.health.lastEventAt <= detectionBudget + 5000 + 2 * policy.pollMs);
      t.diagnostic(JSON.stringify({ scenario: 'alive-original-stall', task_id: stalledId, request_id: stalled.requestId,
        owner_agent_alive_with_same_birth: true, started_at: stalled.startedAt, last_event_at: stalled.health.lastEventAt,
        suspected_at: suspectedStall.health.suspectedAt, sealed_at: stalled.supervisionFailedAt,
        http_at: attempts.map((attempt) => attempt.at), delivered_at: stalled.callbackDeliveredAt,
        policy_ms: policy, detection_ms: detectionMs, detection_budget_ms: detectionBudget,
        state: safeStall.state, callback_kind: safeStall.callback_kind, callback_state: safeStall.callback_state,
        callback_status: safeStall.callback_status, result_status: safeStall.result_status, terminal_at: safeStall.timing.terminal_at,
        business_executions: 1, http_posts: 2, receiver_notifications: 1, receipt_status: 202,
        exact_bytes: true, cancel_events: 0, same_session_followup: 'queued' }));
      interruptCallback = undefined;

      // 持续的真实读取异常只能经连续确认停止自有 driver，再观察原请求；不得重派业务。
      env.OPENCODE_TASK_PROGRESS_MS = '60000';
      const beforeUnreadable = executionCount();
      const unreadableId = faultSubmit('unreadable-heartbeat', 'silent forever');
      await until(() => load(unreadableId).state === 'running' &&
        peerEvents(load(unreadableId)).some((event) => event.type === 'prompt_received'), 'heartbeat fault original received');
      const unreadablePeer = peerEvents(load(unreadableId)).find((event) => event.type === 'prompt_received');
      const unreadableBirth = lines(path.join(base, 'processes')).find((proof) => proof.agent === unreadablePeer.agent);
      assertOriginalAlive(unreadableBirth);
      fs.writeFileSync(path.join(heartbeatFaults, unreadableId), 'persistent');
      await until(() => load(unreadableId).notificationState === 'delivered', 'unreadable heartbeat error delivered');
      const unreadable = load(unreadableId);
      assertOriginalAlive(unreadableBirth);
      assert.equal(unreadable.workerExit.reason, 'WORKER_HEARTBEAT_UNREADABLE');
      assert.equal(unreadable.notificationKind, 'supervision_failure');
      assert.equal(unreadable.state, 'ambiguous');
      assert.equal(unreadable.resultStatus, undefined);
      assert.equal(JSON.parse(unreadable.body).status, 'error');
      assert.match(JSON.parse(unreadable.body).output, /unknown.*WORKER_HEARTBEAT_UNREADABLE/);
      assert.equal(callbacks(unreadable).length, 1);
      assert.equal(executionCount(), beforeUnreadable + 1);
      assert.equal(peerEvents(unreadable).some((event) => event.type === 'cancel'), false);
      assert.equal(journalEntries(unreadable).some((event) => event.type === 'turn_result' && event.request_id === unreadable.requestId), false);
      const readErrors = lines(path.join(base, 'heartbeat-read-errors.ndjson')).filter((event) => event.taskId === unreadableId);
      const attemptsFor = (role) => new Set(lines(path.join(base, 'drivers.ndjson'))
        .filter((event) => event.taskId === unreadableId && event.role === role).map((event) => event.pid)).size;
      assert.ok(readErrors.length >= 4);
      assert.equal(attemptsFor('_worker'), 1);
      assert.equal(attemptsFor('_observe'), 1);
      assert.ok(unreadable.supervisionFailedAt - readErrors[0].at >= 2 * unreadable.health.policy.confirmMs);
      t.diagnostic(JSON.stringify({ scenario: 'persistent-heartbeat-read-error', read_errors: readErrors.length,
        confirmation_ms: unreadable.health.policy.confirmMs, elapsed_ms: unreadable.callbackDeliveredAt - readErrors[0].at,
        initial_drivers: 1, observer_drivers: 1, business_executions: 1, http_posts: 1,
        callback_status: 'error', callback_state: 'delivered', owner_agent_alive_with_same_birth: true, cancel_events: 0 }));
      env.OPENCODE_TASK_PROGRESS_MS = '10000';
      env.OPENCODE_TASK_CONFIRM_MS = '600';
      env.OPENCODE_TASK_WORKER_MS = '300';
      env.OPENCODE_TASK_CONFIRM_MS = '1200';
      const pausedId = faultSubmit('paused-worker', 'long tool');
      await until(() => load(pausedId).state === 'running');
      const pausedPid = Number(fs.readFileSync(pidfile(pausedId), 'utf8'));
      const pausedToken = JSON.parse(fs.readFileSync(path.join(root, 'runtime/tasks', pausedId, 'worker.json'), 'utf8')).token;
      process.kill(pausedPid, 'SIGSTOP');
      try {
        await pause(800); // 超过 worker 阈值，低于阈值加连续确认，正常恢复应保留该 child。
        assert.equal(JSON.parse(readerCli(['status', pausedId]).stdout).health.worker_assessment, 'suspected');
      } finally { process.kill(pausedPid, 'SIGCONT'); }
      const pausedRecord = await delivered(pausedId);
      assert.equal(pausedRecord.resultStatus, 'success');
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'runtime/tasks', pausedId, 'worker.json'), 'utf8')).token, pausedToken);
      assert.equal(pausedRecord.workerExit.reason, 'WORKER_EXITED');
      env.OPENCODE_TASK_CONFIRM_MS = '600';
      const beforeStopped = fs.readFileSync(executions, 'utf8').trim().split('\n').length;
      const stoppedId = faultSubmit('stopped-worker', 'long tool');
      await until(() => load(stoppedId).state === 'running');
      const stoppedPid = Number(fs.readFileSync(pidfile(stoppedId), 'utf8'));
      process.kill(stoppedPid, 'SIGSTOP');
      const stoppedRecord = await delivered(stoppedId); // 监护结束自有 child，observer 接续原请求。
      assert.equal(stoppedRecord.resultStatus, 'success');
      assert.equal(stoppedRecord.terminalSource, 'watchSession.turn_result');
      assert.notEqual(Number(fs.readFileSync(pidfile(stoppedId), 'utf8')), stoppedPid);
      assert.equal(fs.readFileSync(executions, 'utf8').trim().split('\n').length, beforeStopped + 1);
      env.OPENCODE_TASK_WORKER_MS = '5000';
      const lostId = faultSubmit('owner-exit', 'wait for cancellation');
      await until(() => load(lostId).state === 'running' &&
        peerEvents(load(lostId)).some((event) => event.type === 'prompt_received'), 'owner-exit original received by peer');
      const lostPeer = peerEvents(load(lostId)).find((event) => event.type === 'prompt_received');
      const owned = lines(path.join(base, 'processes')).find((proof) => proof.agent === lostPeer.agent && proof.owner === lostPeer.owner);
      assert.ok(fs.readFileSync(`/proc/${owned.owner}/cmdline`, 'utf8').includes(path.join(version, 'node_modules/acpx')));
      process.kill(owned.owner, 'SIGKILL');
      await until(() => load(lostId).notificationState === 'delivered');
      const lost = load(lostId);
      assert.equal(lost.state, 'ambiguous');
      assert.equal(lost.resultStatus, undefined);
      assert.match(JSON.parse(lost.body).output, /side effects are unknown/);
      const unknown = JSON.parse(cli(['result', lostId]).stdout);
      assert.equal(unknown.result_status, null);
      assert.equal(unknown.callback_kind, 'supervision_failure');
      assert.equal(unknown.timing.terminal_at, null);
      assert.equal(seen.filter((body) => JSON.parse(body).callback_id === JSON.parse(lost.body).callback_id).length, 1);
      assert.equal(cli(['recover', lostId]).status, 0);
      assert.equal(load(lostId).body, lost.body);
      assert.equal(cli(['cancel', lostId]).status, 1); // Dead owner's cancellation cannot be confirmed.
      assert.equal(JSON.parse(cli(['status', lostId]).stdout).cancel_requested, true);
      try {
        const ticks = fs.readFileSync(`/proc/${owned.agent}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/)[19];
        if (ticks === owned.startTicks) process.kill(owned.agent, 'SIGKILL');
      } catch {}
      const legacyRunner = new TaskRunner({ root: path.join(root, 'runtime/tasks') });
      const legacy = legacyRunner.submit({ key: 'legacy-unsealed', cwd: base, prompt: 'Synthetic prior task.',
        callback: JSON.parse(registrationFor('r')) });
      const legacyRecord = legacyRunner.load(legacy.task_id);
      legacyRecord.state = 'ambiguous';
      legacyRunner.write(legacyRecord);
      const verifiedFile = path.join(base, 'verified.txt');
      fs.writeFileSync(verifiedFile, 'Independently verified fixture result.');
      const beforeResolve = fs.readFileSync(executions, 'utf8');
      const resolved = readerCli(['resolve', legacy.task_id, '--status', 'success', '--output-file', verifiedFile]);
      assert.equal(resolved.status, 0, resolved.stderr);
      const resolvedRecord = await delivered(legacy.task_id); // No recover call is allowed to start delivery.
      assert.equal(resolvedRecord.terminalSource, 'operator_resolution');
      assert.equal(JSON.parse(resolvedRecord.body).output, 'Independently verified fixture result.');
      assert.deepEqual(seen.filter((body) => JSON.parse(body).callback_id === legacyRecord.callback.callback_id), [resolvedRecord.body]);
      assert.equal(fs.readFileSync(executions, 'utf8'), beforeResolve);
      for (const lockName of ['monitor.lock', 'worker.lock']) {
        const pending = legacyRunner.submit({ key: `launch-failure-${lockName}`, cwd: base, prompt: 'Never dispatched.',
          callback: JSON.parse(registrationFor(lockName[0])) });
        const lockPath = legacyRunner.filename(pending.task_id, lockName);
        fs.writeFileSync(lockPath, '', { mode: 0o600 });
        const locker = spawn('python3', ['-B', '-c',
          "import fcntl, sys; lock = open(sys.argv[1], 'r+'); fcntl.flock(lock, fcntl.LOCK_EX); print('ready', flush=True); sys.stdin.buffer.read(1)",
          lockPath], { cwd: base, env: { PATH: env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] });
        const exited = new Promise((resolve) => locker.once('exit', resolve));
        try {
          await new Promise((resolve, reject) => { locker.once('error', reject); locker.stdout.once('data', resolve); });
          const beforeFailure = fs.readFileSync(legacyRunner.filename(pending.task_id));
          const refused = readerCli(['_fail_launch', pending.task_id]);
          assert.equal(refused.status, 1, JSON.stringify({ phase: 'launch-failure-lock', lockName,
            taskId: pending.task_id, status: refused.status, signal: refused.signal,
            error: refused.error?.message, stdout: refused.stdout, stderr: refused.stderr }));
          assert.deepEqual(fs.readFileSync(legacyRunner.filename(pending.task_id)), beforeFailure);
        } finally {
          locker.stdin.end();
          await exited;
        }
        let concurrentRecovery;
        if (lockName === 'monitor.lock') interruptCallback = (body) => {
          if (JSON.parse(body).callback_id !== legacyRunner.load(pending.task_id).callback.callback_id) return false;
          interruptCallback = undefined;
          concurrentRecovery = readerCli(['recover', pending.task_id]);
          return true; // Lose the first receipt while recover sees this monitor's lock.
        };
        const finalizing = spawn(path.join(root, 'bin/opencode-task'), ['_fail_launch', pending.task_id], {
          cwd: base, env: { PATH: env.PATH, HOME: base }, stdio: 'ignore',
        });
        assert.equal(await new Promise((resolve, reject) => {
          finalizing.once('error', reject);
          finalizing.once('exit', resolve);
        }), 0);
        const launchFailed = await delivered(pending.task_id);
        assert.equal(launchFailed.executionError, 'SUPERVISOR_START_FAILED');
        assert.equal(launchFailed.resultStatus, 'error');
        assert.equal(launchFailed.terminalSource, 'execution_setup_failure');
        const failureBodies = seen.filter((body) => JSON.parse(body).callback_id === launchFailed.callback.callback_id);
        assert.deepEqual(failureBodies, Array(lockName === 'monitor.lock' ? 2 : 1).fill(launchFailed.body));
        if (lockName === 'monitor.lock') assert.equal(concurrentRecovery.status, 0, concurrentRecovery.stderr);
        assert.equal(fs.readFileSync(executions, 'utf8'), beforeResolve);
      }
      phase = 'high-level-launch';
      const gitAt = (cwd, ...args) => {
        const value = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
        assert.equal(value.status, 0, value.stderr);
        return value.stdout.trim();
      };
      const launchRepo = path.join(base, 'launch-repo'), launchOrigin = path.join(base, 'launch-origin');
      fs.mkdirSync(launchRepo); fs.mkdirSync(launchOrigin);
      gitAt(launchOrigin, 'init', '--bare', '--initial-branch=main');
      gitAt(launchRepo, 'init', '--initial-branch=main');
      gitAt(launchRepo, 'config', 'user.name', 'Fixture');
      gitAt(launchRepo, 'config', 'user.email', 'fixture@example.invalid');
      fs.writeFileSync(path.join(launchRepo, 'tracked'), 'base\n');
      gitAt(launchRepo, 'add', 'tracked'); gitAt(launchRepo, 'commit', '-m', 'base');
      gitAt(launchRepo, 'remote', 'add', 'origin', launchOrigin); gitAt(launchRepo, 'push', 'origin', 'main');
      // 仅调用者 HOME 的 URL rewrite 能解析此 origin；launch 必须保留 Git 配置环境。
      gitAt(base, 'config', '--file', path.join(base, '.gitconfig'), `url.${base}/.insteadOf`, 'fixture-origin:');
      gitAt(launchRepo, 'remote', 'set-url', 'origin', 'fixture-origin:launch-origin');
      const launchBase = gitAt(launchRepo, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(launchRepo, 'dirty'), 'unrelated work');
      const launchInput = { schema_version: 1, key: 'launch-high', repo_path: launchRepo,
        branch: 'feat/launch', worktree: 'launch-work', prompt: 'write fixture', permissions: { mode: 'approve-all' },
        callback: { callback_id: `tcb_${'launch-high'.padEnd(43, 'q')}`, callback_url: JSON.parse(registration).callback_url } };
      const launchFile = path.join(base, 'launch-input.json');
      fs.writeFileSync(launchFile, JSON.stringify(launchInput), { mode: 0o600 });
      const launchArgs = ['launch', '--input-file', launchFile];
      const parallelLaunch = () => new Promise((resolve, reject) => {
        const child = spawn(path.join(root, 'bin/opencode-task'), launchArgs, { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
        child.once('error', reject); child.once('exit', (status) => resolve({ status, stdout, stderr }));
      });
      const beforeLaunch = fs.readFileSync(executions, 'utf8');
      const concurrent = await Promise.all([parallelLaunch(), parallelLaunch()]);
      for (const value of concurrent) assert.equal(value.status, 0, value.stdout + value.stderr);
      const [created, reusedLaunch] = concurrent.map((value) => JSON.parse(value.stdout)).sort((a, b) => Number(a.reused) - Number(b.reused));
      assert.equal(created.reused, false); assert.equal(reusedLaunch.reused, true);
      assert.equal(created.task_id, reusedLaunch.task_id); assert.equal(created.request_id, reusedLaunch.request_id);
      assert.equal(created.base_sha, launchBase); assert.equal(created.accepted, true);
      const launchDone = await delivered(created.task_id);
      assert.match(JSON.parse(launchDone.body).output, /Write permitted; turn 1/);
      assert.equal(fs.readFileSync(path.join(launchRepo, 'dirty'), 'utf8'), 'unrelated work');
      assert.equal(fs.readFileSync(executions, 'utf8'), beforeLaunch + 'prompt\n');
      const retryLaunch = cli(launchArgs);
      assert.equal(retryLaunch.status, 0, retryLaunch.stdout + retryLaunch.stderr);
      assert.equal(JSON.parse(retryLaunch.stdout).request_id, created.request_id);
      const incremental = { schema_version: 1, key: 'launch-follow', prompt: 'write fixture',
        callback: { ...launchInput.callback, callback_id: `tcb_${'launch-follow'.padEnd(43, 'q')}` } };
      fs.writeFileSync(launchFile, JSON.stringify(incremental));
      const follow = cli([...launchArgs, '--continue-from', created.task_id]);
      assert.equal(follow.status, 0, follow.stdout + follow.stderr);
      const followed = JSON.parse(follow.stdout), followDone = await delivered(followed.task_id);
      assert.equal(followed.session, created.session); assert.equal(followed.permissions.mode, 'approve-all');
      assert.equal(followDone.handle.backendSessionId, launchDone.handle.backendSessionId);
      assert.match(JSON.parse(followDone.body).output, /Write permitted; turn 2/);
      assert.equal(fs.readFileSync(executions, 'utf8'), beforeLaunch + 'prompt\nprompt\n');
      assert.equal(JSON.stringify(concurrent).includes(launchInput.callback.callback_id), false);
      phase = 'launch-missing-session';
      const sessionRecord = path.join(root, 'runtime/home/.acpx/sessions', `${encodeURIComponent(followDone.handle.acpxRecordId)}.json`);
      fs.renameSync(sessionRecord, sessionRecord + '.saved');
      try {
        fs.writeFileSync(launchFile, JSON.stringify({ ...incremental, key: 'launch-missing',
          callback: { ...incremental.callback, callback_id: `tcb_${'launch-missing'.padEnd(43, 'q')}` } }));
        const missing = cli([...launchArgs, '--continue-from', followed.task_id]);
        assert.equal(missing.status, 0, missing.stdout + missing.stderr);
        const missingDone = await delivered(JSON.parse(missing.stdout).task_id);
        assert.equal(missingDone.resultStatus, 'error');
        assert.equal(missingDone.terminalSource, 'execution_setup_failure');
        assert.equal(fs.readFileSync(executions, 'utf8'), beforeLaunch + 'prompt\nprompt\n');
      } finally { fs.renameSync(sessionRecord + '.saved', sessionRecord); }
      // 全部断言完成后才清理 fixture；finally 会等待自有进程退出，再删除临时目录。
      assert.deepEqual(callbacks(load(stalledId)), [stalled.body, stalled.body]);
      assert.equal(peerEvents(stalled).some((event) => event.type === 'cancel'), false);
      assert.deepEqual(lines(path.join(base, 'driver-errors.ndjson')), []);
    } catch (error) {
      primaryError = error;
      // 先保留首错与阶段；即使随后清理失败，原 stack 仍作为测试失败返回。
      try { console.error(JSON.stringify({ phase, temporary_root: base, first_failure: error.message, stack: error.stack,
        driver_errors: fs.existsSync(path.join(base, 'driver-errors.ndjson')) ?
          fs.readFileSync(path.join(base, 'driver-errors.ndjson'), 'utf8').trim().split('\n').map(JSON.parse) : [] })); }
      catch { /* 诊断输出失败时仍保留同一个 primaryError。 */ }
    } finally {
      await finishFixture(primaryError, async () => {
        try { console.error(JSON.stringify({ fixture_phase: 'cleanup', after_failure: Boolean(primaryError), at: Date.now() })); }
        catch { /* 诊断不能阻止进程收尾。 */ }
        try {
          for (const witness of witnesses) await witness.close();
          await stopFixtureProcesses(base, version);
        } finally {
          // 清理被拒绝时也释放本地 receiver，不能让首错变成测试进程悬挂。
          await new Promise((resolve) => { webhook.close(resolve); webhook.closeAllConnections(); });
        }
        if (!primaryError) fs.rmSync(base, { recursive: true, force: true });
        t.diagnostic(JSON.stringify({ phase: 'cleanup', writers_stopped: true, temporary_root_removed: !primaryError,
          retained_failure_root: primaryError ? base : undefined }));
      }, (value) => t.diagnostic(JSON.stringify(value)));
    }
  },
);

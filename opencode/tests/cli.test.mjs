import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TaskRunner } from "../scripts/task.mjs";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "actual wrapper/CLI: detached submit, private stdin, lost receipt/worker restart, dedupe and status",
  { timeout: 120000 },
  async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "module-cli-"));
    fs.chmodSync(base, 0o700);
    const root = path.join(base, "toolset");
    const version = path.join(root, "versions/fixture");
    fs.mkdirSync(version, { recursive: true, mode: 0o700 });
    for (const dir of [root, path.join(root, "versions"), version])
      fs.chmodSync(dir, 0o700);
    for (const name of [
      "runtime.py",
      "safety.py",
      "profiles.py",
      "profile-env.json",
      "task.mjs",
      "task-cli.mjs",
      "task-acp.mjs",
      "task-supervisor.mjs",
    ])
      fs.copyFileSync(path.join(scripts, name), path.join(version, name));
    // Only this synthetic fixture may expose diagnostics from its copied worker.
    const copiedCli = path.join(version, 'task-cli.mjs');
    fs.writeFileSync(copiedCli, fs.readFileSync(copiedCli, 'utf8').replace(
      '} catch (error) {\n  // No raw', `} catch (error) {\n  fs.appendFileSync(${JSON.stringify(path.join(base, 'worker-errors'))}, error.stack + '\\n');\n  // No raw`).replace(
      'const stored = runner.load(id);', `const stored = runner.load(id);\n      if (['_worker', '_observe', '_supervise'].includes(command)) fs.writeFileSync(${JSON.stringify(base)} + '/' + (command === '_supervise' ? 'monitor' : 'worker') + '-' + id + '.pid', String(process.pid));`));
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
      fs.writeFileSync(
        path.join(root, "bin", tool),
        `#!/usr/bin/env bash\nset -euo pipefail\n${pid}exec python3 -B ${quote(path.join(root, "active/runtime.py"))} ${tool} "$@"\n`,
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
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: base,
      OPENCODE_ACP_REQUIRED_MODEL: "fixture/test",
      TASK_FIXTURE_LOG: executions,
      TASK_FIXTURE_CONTROL_LOG: path.join(base, 'controls'),
      TASK_FIXTURE_PROCESS_LOG: path.join(base, 'processes'),
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
      OPENCODE_TASK_DRAIN_MS: '30',
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
    let interruptCallback;
    const webhook = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        seen.push(data);
        if (seen.length === 1 || interruptCallback?.(data)) req.socket.destroy();
        else {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              version: 1,
              receipt_id: "durable-fixture",
              accepted_at: new Date().toISOString(),
            }),
          );
        }
      });
    });
    await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    let taskId;
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
      const until = async (condition) => {
        const end = Date.now() + 10000;
        while (!condition()) {
          if (Date.now() > end) throw new Error("CLI fixture timed out");
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
        try { await until(() => load(id).state === "delivered"); }
        catch {
          const { state, executionError, health, workerExit } = load(id);
          const observations = Object.fromEntries(['worker.json', 'monitor.json'].map((name) => {
            const file = path.join(root, 'runtime/tasks', id, name);
            return [name, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null];
          }));
          throw new Error(JSON.stringify({ state, executionError, health, workerExit,
            now: Date.now(), observations,
            fixtureErrors: fs.existsSync(path.join(base, 'worker-errors')) ? fs.readFileSync(path.join(base, 'worker-errors'), 'utf8') : '' }));
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
      const faultSubmit = (key, prompt) => {
        fs.writeFileSync(modelFile, prompt);
        const result = cli(['submit', '--key', key, '--prompt-file', modelFile],
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
      const slow = await delivered(faultSubmit('healthy-tool', 'long tool'));
      assert.equal(slow.resultStatus, 'success');
      assert.equal(JSON.parse(slow.body).output, 'Slow tool completed');
      env.OPENCODE_TASK_PROGRESS_MS = '10000';
      const lostId = faultSubmit('owner-exit', 'wait for cancellation');
      await until(() => load(lostId).state === 'running');
      const owned = JSON.parse(fs.readFileSync(path.join(base, 'processes'), 'utf8').trim().split('\n').at(-1));
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
          assert.equal(readerCli(['_fail_launch', pending.task_id]).status, 1);
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
      // Graceful fixture shutdown only; never wait for an idle ACP owner to report completion.
      const { createSharedAcpRuntime, createAgentRegistry } =
        await import("../scripts/node_modules/acpx/dist/runtime.js");
      const priorHome = process.env.HOME;
      process.env.HOME = path.join(root, "runtime/home");
      const runtime = createSharedAcpRuntime({
        cwd: base,
        permissionMode: "deny-all",
        agentRegistry: createAgentRegistry({
          overrides: { opencode: [path.join(root, "bin/opencode"), "acp"] },
        }),
      });
      try {
        for (const handle of [stored.handle, afterCancel.handle, chosenRecord.handle, failed.handle, exited.handle, slow.handle])
          await runtime.close({ handle, reason: "CLI fixture cleanup" });
      } finally {
        await runtime.shutdown();
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
      }
    } finally {
      webhook.close();
      for (const name of fs
        .readdirSync(base)
        .filter((name) => /^(worker|monitor)-task_.*\.pid$/.test(name))) {
        try {
          const pid = Number(fs.readFileSync(path.join(base, name), "utf8"));
          // Only the fixture's own detached worker may be stopped; a stale PID
          // must not identify an unrelated process. Never inspect environments.
          if (
            fs
              .readFileSync(`/proc/${pid}/cmdline`, "utf8")
              .includes(path.join(version, "task-cli.mjs"))
          )
            process.kill(pid, "SIGTERM");
        } catch {}
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);

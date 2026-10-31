/** Synthetic ACP peer for the pinned shared runtime; no network or provider. */
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const send = (value) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
let active;
let turns = 0;
const config = process.env.OPENCODE_CONFIG ? JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8')) : {};
// Check only synthetic fields. Never serialize the child's environment or values.
const inheritedEnvironment = () => Object.entries({
  HTTP_PROXY: 'http://proxy.example.invalid:8080', https_proxy: 'http://proxy.example.invalid:8443',
  ALL_PROXY: 'socks5://proxy.example.invalid:1080', NO_PROXY: 'localhost,127.0.0.1',
  UNLISTED_SERVICE_CREDENTIAL: 'synthetic-custom-auth', UNLISTED_SETTING: 'arbitrary value 值',
  ANTHROPIC_API_KEY: 'synthetic-other-provider', LLM_API_KEY: 'synthetic-legacy-key',
  FIRECRAWL_MCP_ENABLED: '0', FIRECRAWL_MCP_API_KEY: 'synthetic-disabled-mcp',
  FIRECRAWL_MCP_URL: 'ignored invalid endpoint while disabled', LC_ALL: 'C.UTF-8',
}).every(([name, value]) => process.env[name] === value) &&
  !Object.hasOwn(config.mcp?.servers ?? {}, 'firecrawl');
let model = process.env.TASK_FIXTURE_REFUSE_MODEL ? 'fixture/refused' : process.env.OPENCODE_ACP_REQUIRED_MODEL ?? 'fixture/test';
let effort = process.env.OPENCODE_ACP_REQUIRED_VARIANT ?? 'default';
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: Object.entries(config.providers ?? { fixture: { models: { test: {} } } }).flatMap(([provider, info]) =>
      Object.keys(info.models).map((id) => ({ value: `${provider}/${id}`, name: `${provider}/${id}` }))) },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort,
    options: ['low', 'medium', 'high', 'xhigh', 'max', 'default'].map((value) => ({ value, name: value })) },
];
const pending = new Map();
let fixtureOwner = process.ppid;
if (process.env.TASK_FIXTURE_PROCESS_LOG) {
  const ticks = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/)[19];
  const identity = { agent: process.pid, startTicks: ticks(process.pid),
    owner: null, ownerStartTicks: null, invalidOwner: true, observedParent: process.ppid };
  try {
    const parent = identity.observedParent;
    if (parent > 1) {
      const birth = ticks(parent);
      const command = fs.readFileSync(`/proc/${parent}/cmdline`, 'utf8').split('\0');
      const toolset = path.join(path.dirname(process.env.TASK_FIXTURE_PROCESS_LOG), 'toolset');
      if (command.some((arg) => [path.join(toolset, 'versions/fixture/node/bin/node'),
        path.join(toolset, 'active/node/bin/node')].includes(arg)) &&
          process.ppid === parent && ticks(parent) === birth) {
        identity.owner = parent; identity.ownerStartTicks = birth; identity.invalidOwner = false;
      }
    }
  } catch (error) { identity.ownerObservationError = error.code ?? 'UNAVAILABLE'; }
  fixtureOwner = identity.owner;
  // 即使在启动时已被收养，agent 自身出生身份也必须独立登记；不能把 PID 1 当 owner。
  fs.appendFileSync(process.env.TASK_FIXTURE_PROCESS_LOG, JSON.stringify(identity) + "\n");
}
const fixtureEvent = (type, sessionId) => {
  if (process.env.TASK_FIXTURE_EVENT_LOG) fs.appendFileSync(process.env.TASK_FIXTURE_EVENT_LOG,
    JSON.stringify({ type, sessionId, agent: process.pid, owner: fixtureOwner, at: Date.now() }) + "\n");
};
function call(method, params, receive) {
  const id = randomUUID();
  pending.set(id, receive);
  send({ id, method, params });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.method && pending.has(request.id)) {
    const receive = pending.get(request.id);
    pending.delete(request.id);
    receive(request);
    return;
  }
  const reply = (result) => {
    if (request.id !== undefined) send({ id: request.id, result });
  };
  if (request.method === "initialize")
    reply({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "module-fixture", version: "1" },
    });
  else if (request.method === "session/new") reply({ sessionId: randomUUID(), configOptions: configOptions() });
  else if (request.method === "session/load") reply({ configOptions: configOptions() });
  else if (request.method === 'session/set_config_option') {
    if (process.env.TASK_FIXTURE_CONTROL_LOG) fs.appendFileSync(process.env.TASK_FIXTURE_CONTROL_LOG, `${request.params.configId}\n`);
    if (request.params.configId === 'model' && process.env.TASK_FIXTURE_REFUSE_MODEL === request.params.value) {
      send({ id: request.id, error: { code: -32602, message: 'synthetic model refusal' } }); return;
    }
    if (request.params.configId === 'model') model = request.params.value;
    else effort = request.params.value;
    reply({ configOptions: configOptions() });
  }
  else if (request.method === "session/prompt") {
    turns++;
    const text = request.params.prompt.map((part) => part.text ?? "").join("");
    if (
      text.includes("tcb_") ||
      Object.entries(process.env).some(([name, value]) =>
        /^(LC_TASK_CALLBACK|OPENCODE_TASK_CALLBACK)/.test(name) || /tcb_[A-Za-z0-9_-]{43}/.test(value),
      )
    ) {
      send({
        id: request.id,
        error: { code: -32602, message: "Callback leaked to ACP fixture" },
      });
      return;
    }
    if (process.env.TASK_FIXTURE_ENV_CHECK === '1' && !inheritedEnvironment()) {
      send({ id: request.id, error: { code: -32602, message: 'Synthetic launch environment mismatch' } });
      return;
    }
    if (process.env.TASK_FIXTURE_LOG)
      fs.appendFileSync(process.env.TASK_FIXTURE_LOG, "prompt\n");
    fixtureEvent("prompt_received", request.params.sessionId);
    const finish = (text = "Pinned ACP result") => {
      send({
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "fixture-final",
            content: { type: "text", text },
          },
        },
      });
      reply({ stopReason: "end_turn" });
      active = undefined;
    };
    if (text === "provider failed") {
      send({ id: request.id, error: { code: -32603, message: "synthetic provider.internal",
        data: { service: "session", errorName: "provider.internal" } } });
    } else if (text === "agent exit") process.exit(23);
    else if (text === "silent forever") {
      // 先保持进展，待同 session 跟随请求排队后再注入永久静默，终态永不返回。
      active = { request, timer: setInterval(() => {
        if (fs.existsSync(path.join(process.env.TASK_FIXTURE_PROGRESS_CONTROL, `${request.params.sessionId}.stall`))) {
          clearInterval(active.timer);
          fixtureEvent("silent_started", request.params.sessionId);
        } else send({ method: "session/update", params: { sessionId: request.params.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Synthetic pre-fault progress." } } } });
      }, 100) };
    } else if (text === "recover thought progress") {
      fixtureEvent("thought_ready", request.params.sessionId);
      let quiet = false;
      let resumed;
      active = { request, timer: setInterval(() => {
        if (!quiet) {
          if (fs.existsSync(path.join(process.env.TASK_FIXTURE_PROGRESS_CONTROL, `${request.params.sessionId}.quiet`))) {
            quiet = true;
            fixtureEvent("quiet_started", request.params.sessionId);
          } else send({ method: "session/update", params: { sessionId: request.params.sessionId,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Synthetic pre-fault thought." } } } });
          return;
        }
        // 测试观察到 suspected 后，仅解除合成 peer 的静默，不改任务状态。
        if (!fs.existsSync(path.join(process.env.TASK_FIXTURE_PROGRESS_CONTROL, request.params.sessionId))) return;
        if (resumed === undefined) {
          resumed = performance.now();
          fixtureEvent("thought_resumed", request.params.sessionId);
        }
        if (performance.now() - resumed >= 1600 &&
            fs.existsSync(path.join(process.env.TASK_FIXTURE_PROGRESS_CONTROL, `${request.params.sessionId}.finish`))) {
          clearInterval(active.timer);
          fixtureEvent("thought_completed", request.params.sessionId);
          reply({ stopReason: "end_turn" }); // 全程没有 assistant 文字。
          active = undefined;
        } else send({ method: "session/update", params: { sessionId: request.params.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Synthetic progress." } } } });
      }, 100) };
    }
    else if (text === "long tool") {
      send({ method: "session/update", params: { sessionId: request.params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "slow-tool", title: "Synthetic slow tool", status: "in_progress", kind: "other" } } });
      active = { request, timer: setTimeout(() => {
        send({ method: "session/update", params: { sessionId: request.params.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: "slow-tool", status: "completed" } } });
        finish("Slow tool completed");
      }, 1600) };
    } else if (text.startsWith("write fixture")) {
      call(
        "session/request_permission",
        {
          sessionId: request.params.sessionId,
          toolCall: {
            toolCallId: randomUUID(),
            title: "Edit fixture file",
            kind: "edit",
            rawInput: { name: "edit" },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        (permission) => {
          if (permission.result?.outcome?.optionId !== "allow") {
            finish(`Write denied; turn ${turns}`);
            return;
          }
          call(
            "fs/write_text_file",
            {
              sessionId: request.params.sessionId,
              path: path.join(process.cwd(), "authorized-write.txt"),
              content: `turn ${turns}`,
            },
            (written) => {
              const output = written.error
                ? `Write denied; turn ${turns}`
                : `Write permitted; turn ${turns}`;
              if (text.endsWith("then wait"))
                active = {
                  request,
                  timer: setTimeout(() => finish(output), 1500),
                };
              else finish(output);
            },
          );
        },
      );
    } else if (text === 'model selection') finish(JSON.stringify({ model, effort, title: config.agents?.title?.model,
      env: ['CODEX_API_KEY', 'COPILOT_API_KEY'].filter((name) => Boolean(process.env[name])),
      inheritedEnvironment: inheritedEnvironment() }));
    else if (text === "continuity") finish(`Session turn ${turns}`);
    else if (text === "wait for cancellation")
      active = { request, timer: setTimeout(() => finish(), 30000) };
    else finish();
  } else if (request.method === "session/cancel") {
    fixtureEvent("cancel", request.params.sessionId);
    if (active) {
      clearTimeout(active.timer);
      send({ id: active.request.id, result: { stopReason: "cancelled" } });
      active = undefined;
    }
    reply({});
  } else if (request.id !== undefined) reply({});
});

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
      Object.values(process.env).some((value) =>
        /tcb_[A-Za-z0-9_-]{43}/.test(value),
      )
    ) {
      send({
        id: request.id,
        error: { code: -32602, message: "Callback leaked to ACP fixture" },
      });
      return;
    }
    if (process.env.TASK_FIXTURE_LOG)
      fs.appendFileSync(process.env.TASK_FIXTURE_LOG, "prompt\n");
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
    if (text.startsWith("write fixture")) {
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
      env: ['CODEX_API_KEY', 'COPILOT_API_KEY'].filter((name) => Boolean(process.env[name])) }));
    else if (text === "continuity") finish(`Session turn ${turns}`);
    else if (text === "wait for cancellation")
      active = { request, timer: setTimeout(() => finish(), 30000) };
    else finish();
  } else if (request.method === "session/cancel") {
    if (active) {
      clearTimeout(active.timer);
      send({ id: active.request.id, result: { stopReason: "cancelled" } });
      active = undefined;
    }
    reply({});
  } else if (request.id !== undefined) reply({});
});

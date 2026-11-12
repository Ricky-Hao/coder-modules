/** Opt-in: isolated published binary, synthetic Responses and callbacks only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createSharedAcpRuntime, createAgentRegistry } from "../scripts/node_modules/acpx/dist/runtime.js";
import { TaskStore } from "../scripts/task.mjs";
import { TaskWorker } from "../scripts/task-worker.mjs";
import { readyTask } from "./task-fixture.mjs";

for (const [provider, rejectUpgrade] of [["codex", false], ["copilot", false], ["codex", true], ["copilot", true]]) test(`published OpenCode ${provider}${rejectUpgrade ? " fallback" : ""}: transport, native compaction, failure and same session`,
  { skip: !process.env.OPENCODE_FIXTURE_BINARY, timeout: 150000 }, async () => {
    const base = fs.mkdtempSync(path.join(process.env.OPENCODE_EVIDENCE_DIR || os.tmpdir(), `published-${provider}-`));
    fs.chmodSync(base, 0o700);
    const prior = { ...process.env };
    let failing = true;
    const calls = [];
    const upgrades = [];
    const notifications = [];
    const journalEvents = [];
    let toolSent = false;
    let toolResponse;
    const reference = path.join(base, "reference.txt");
    const checkpoint = "synthetic-encrypted-checkpoint";
    fs.writeFileSync(reference, "Synthetic WebSocket tool continuation\n", { mode: 0o600 });
    const respond = (body, transport, send) => {
      assert.equal(JSON.stringify(body).includes("tcb_"), false);
      if (process.env.OPENCODE_EVIDENCE_DIR)
        fs.appendFileSync(path.join(base, "requests.jsonl"), JSON.stringify({ transport, body }) + "\n", { mode: 0o600 });
      const event = (value) => {
        if (process.env.OPENCODE_EVIDENCE_DIR)
          fs.appendFileSync(path.join(base, "responses.jsonl"), JSON.stringify({ transport, event: value }) + "\n", { mode: 0o600 });
        send(value);
      };
      const compact = body.input?.some((item) => item.type === "compaction_trigger");
      calls.push({ model: body.model, effort: body.reasoning?.effort, transport, type: body.type, previous: body.previous_response_id,
        compact, checkpoint: body.input?.some((item) => item.type === "compaction" && item.encrypted_content === checkpoint),
        oldToolCall: body.input?.some((item) => item.type === "function_call" && item.call_id === "call_read"),
        toolOutput: body.input?.some((item) => item.type === "function_call_output" && item.output.includes("Synthetic WebSocket tool continuation")) });
      if (transport === "websocket") {
        assert.equal(body.type, "response.create"); assert.equal(body.stream, undefined);
      }
      const id = `resp_${randomUUID()}`;
      if (compact) {
        assert.equal(body.input.at(-1).type, "compaction_trigger");
        assert.ok(calls.at(-1).toolOutput);
        assert.equal(typeof toolResponse, "string");
        // The native WebSocket channel can reference the completed tool response; HTTP replays the full window.
        if (transport === "websocket") assert.equal(body.previous_response_id, toolResponse);
        else {
          assert.equal(body.previous_response_id, undefined);
          assert.ok(calls.at(-1).oldToolCall);
          assert.ok(body.input.some((item) => item.role === "user"));
        }
        const item = { type: "compaction", id: "cmp_fixture", encrypted_content: checkpoint };
        event({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
        event({ type: "response.output_item.done", output_index: 0, item });
        event({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item],
          usage: { input_tokens: 258400, output_tokens: 4, total_tokens: 258404 } } });
        return;
      }
      if (failing && body.reasoning?.effort !== "low") {
        event({ type: "response.failed", response: { id, object: "response", status: "failed",
          error: { type: "invalid_request_error", code: "invalid_request", message: "Synthetic response stream failure" } } });
        return;
      }
      const tool = !toolSent && body.reasoning?.effort !== "low";
      if (tool) { toolSent = true; toolResponse = id; }
      const item = tool ? { id: "fc_fixture", type: "function_call", call_id: "call_read", name: "read",
        arguments: JSON.stringify({ path: reference }), status: "completed" } :
        { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "Published loopback result", annotations: [] }] };
      event({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
      event({ type: "response.output_item.added", output_index: 0, item: tool ? { ...item, arguments: "", status: "in_progress" } :
        { ...item, status: "in_progress", content: [] } });
      if (tool) {
        event({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
        event({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
      } else {
        event({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
          part: { type: "output_text", text: "", annotations: [] } });
        event({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Published loopback result" });
        event({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Published loopback result" });
      }
      event({ type: "response.output_item.done", output_index: 0, item });
      // A measured full input window makes the pinned runner compact automatically before its next step.
      const inputTokens = tool ? 258400 : 10;
      event({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 4, total_tokens: inputTokens + 4 } } });
    };
    const server = http.createServer((request, response) => {
      let input = "";
      request.on("data", (chunk) => { input += chunk; });
      request.on("end", () => {
        if (request.url === "/api/agents/task-callbacks") {
          notifications.push(input);
          response.writeHead(202, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ version: 1, receipt_id: "published-fixture", accepted_at: new Date().toISOString() }));
          return;
        }
        assert.ok(request.url.endsWith("/responses"));
        const body = JSON.parse(input);
        const event = (value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        respond(body, "http", event);
        response.end();
      });
    });
    const { WebSocketServer } = createRequire(import.meta.url)(process.env.OPENCODE_FIXTURE_WS || "ws");
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      upgrades.push({ path: request.url, beta: request.headers["openai-beta"] });
      if (rejectUpgrade) { socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n"); return; }
      sockets.handleUpgrade(request, socket, head, (ws) => ws.on("message", (data) => {
        respond(JSON.parse(data), "websocket", (value) => ws.send(JSON.stringify(value)));
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const config = JSON.parse(fs.readFileSync(new URL("../scripts/profile-env.json", import.meta.url), "utf8"));
    config.model.providerID = provider; config.agents.title.model.providerID = provider;
    config.mcp = { servers: {} };
    for (const provider of Object.values(config.providers)) provider.settings = { ...provider.settings, baseURL: endpoint + "/v1", apiKey: "synthetic-key" };
    const configFile = path.join(base, "config.json");
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    Object.assign(process.env, { HOME: base, TMPDIR: base, XDG_DATA_HOME: path.join(base, "data"),
      XDG_CONFIG_HOME: path.join(base, "config"), XDG_CACHE_HOME: path.join(base, "cache"), XDG_STATE_HOME: path.join(base, "state"),
      OPENCODE_CONFIG: configFile, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_ACP_REQUIRED_MODEL: `${provider}/gpt-6.1-sol`, OPENCODE_ACP_REQUIRED_VARIANT: "max" });
    const runtime = createSharedAcpRuntime({ cwd: base, permissionMode: "approve-all", nonInteractivePermissions: "deny", authPolicy: "skip",
      ttlMs: 1000, agentRegistry: createAgentRegistry({ overrides: { opencode: [process.env.OPENCODE_FIXTURE_BINARY, "acp"] } }) });
    const watchSession = runtime.watchSession.bind(runtime);
    runtime.watchSession = async function* (options) {
      for await (const event of watchSession(options)) {
        journalEvents.push({ at: Date.now(), requestId: event.requestId, type: event.type,
          update: event.message?.params?.update?.sessionUpdate });
        yield event;
      }
    };
    const taskRoot = path.join(base, "tasks");
    fs.mkdirSync(taskRoot, { mode: 0o700 });
    const store = new TaskStore(taskRoot);
    let handle;
    const shutdown = runtime.shutdown.bind(runtime);
    try {
      const submit = (key, letter) => readyTask(store, { key, prompt: "Synthetic fixture: answer one short sentence.",
        callback: { callback_id: `tcb_${letter.repeat(43)}`, callback_url: endpoint + "/api/agents/task-callbacks" } },
        { cwd: base, sessionKey: "original", noProgressMs: 30000, model: { id: `${provider}/gpt-6.1-sol`, variant: 'max' }, modelConfig: configFile });
      const failed = submit("failed-response", "f");
      const worker = () => new TaskWorker(store, { runtime, pollMs: 100 });
      // This fixture deliberately reuses the native client for a second turn;
      // production workers each detach their own client at exit.
      runtime.shutdown = async () => {};
      await worker().run(failed); handle = failed.handle;
      const firstResult = store.summary(failed, { output: true });
      assert.equal(firstResult.result_status, "error");
      assert.equal(firstResult.terminal_source, "watchSession.turn_result");
      assert.equal(firstResult.callback_output.includes("Synthetic response stream failure"), false);
      failing = false;
      const success = submit("followup", "s");
      await worker().run(success);
      assert.equal(store.summary(success).result_status, "success", JSON.stringify({ calls, journalEvents }));
      assert.equal(store.summary(success, { output: true }).output, "Published loopback result");
      assert.equal(success.handle.acpxRecordId, handle.acpxRecordId);
      const resumed = submit("after-compaction", "r");
      await worker().run(resumed);
      assert.equal(store.summary(resumed).result_status, "success");
      assert.equal(resumed.handle.acpxRecordId, handle.acpxRecordId);
      assert.equal(notifications.length, 3);
      assert.ok(calls.some((call) => call.effort === "max"));
      assert.ok(calls.some((call) => call.effort === "low"));
      assert.ok(calls.every((call) => call.model === "gpt-6.1-sol"));
      assert.ok(calls.filter((call) => call.effort === "low").every((call) => call.transport === "http"));
      assert.ok(calls.filter((call) => call.effort === "low").every((call) => !call.compact && !call.checkpoint));
      assert.ok(calls.some((call) => call.toolOutput));
      assert.ok(upgrades.length > 0);
      assert.ok(upgrades.every((upgrade) => upgrade.path === "/v1/responses" && upgrade.beta === "responses_websockets=2026-02-06"));
      assert.ok(calls.filter((call) => call.effort === "max").every((call) => call.transport === (rejectUpgrade ? "http" : "websocket")));
      const compactions = calls.filter((call) => call.compact);
      assert.equal(compactions.length, 1, JSON.stringify(calls));
      assert.equal(compactions[0].transport, rejectUpgrade ? "http" : "websocket");
      const after = calls.slice(calls.indexOf(compactions[0]) + 1).filter((call) => call.effort === "max");
      assert.ok(after.length >= 2);
      assert.ok(after[0].checkpoint, JSON.stringify(calls));
      assert.ok(after.every((call) => !call.oldToolCall && !call.toolOutput));
      if (rejectUpgrade) assert.equal(upgrades.length, 1); // Connect failure pins this session to HTTP.
      else assert.ok(after.some((call) => typeof call.previous === "string"));
      console.log(JSON.stringify({ provider, rejected_upgrade: rejectUpgrade, upgrades: upgrades.length, calls,
        same_session: true, callbacks: notifications.length }));
    } finally {
      if (handle) await runtime.close({ handle, reason: "published fixture cleanup" }).catch(() => {});
      await shutdown();
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
      if (!process.env.OPENCODE_EVIDENCE_DIR) fs.rmSync(base, { recursive: true, force: true });
    }
  });

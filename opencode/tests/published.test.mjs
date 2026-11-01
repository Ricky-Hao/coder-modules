/** Opt-in: isolated published binary, synthetic Responses and callbacks only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSharedAcpRuntime, createAgentRegistry } from "../scripts/node_modules/acpx/dist/runtime.js";
import { TaskStore } from "../scripts/task.mjs";
import { TaskWorker } from "../scripts/task-worker.mjs";
import { readyTask } from "./task-fixture.mjs";

for (const provider of ["codex", "copilot"]) test(`published OpenCode ${provider}: HTTP 200 response.failed becomes request failure; same session can continue`,
  { skip: !process.env.OPENCODE_FIXTURE_BINARY, timeout: 150000 }, async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "published-acp-"));
    fs.chmodSync(base, 0o700);
    const prior = { ...process.env };
    let failing = true;
    const calls = [];
    const notifications = [];
    const journalEvents = [];
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
        assert.equal(input.includes("tcb_"), false);
        const body = JSON.parse(input);
        calls.push(body.reasoning?.effort);
        const id = `resp_${randomUUID()}`;
        const event = (value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (failing && body.reasoning?.effort !== "low") {
          event({ type: "response.failed", response: { id, object: "response", status: "failed",
            error: { type: "server_error", code: "upstream_stream_error", message: "Synthetic response stream failure" } } });
        } else {
          const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "Published loopback result", annotations: [] }] };
          event({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
          event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
          event({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] } });
          event({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Published loopback result" });
          event({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Published loopback result" });
          event({ type: "response.output_item.done", output_index: 0, item });
          event({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item],
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
        }
        response.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const config = JSON.parse(fs.readFileSync(new URL("../scripts/profile-env.json", import.meta.url), "utf8"));
    config.model.providerID = provider; config.agents.title.model.providerID = provider;
    config.mcp = { servers: {} };
    for (const provider of Object.values(config.providers)) provider.settings = { baseURL: endpoint + "/v1", apiKey: "synthetic-key" };
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
    try {
      const submit = (key, letter) => readyTask(store, { key, prompt: "Synthetic fixture: answer one short sentence.",
        callback: { callback_id: `tcb_${letter.repeat(43)}`, callback_url: endpoint + "/api/agents/task-callbacks" } },
        { cwd: base, sessionKey: "original", noProgressMs: 30000, model: { id: `${provider}/gpt-6.1-sol`, variant: 'max' }, modelConfig: configFile });
      const failed = submit("failed-response", "f");
      const worker = () => new TaskWorker(store, { runtime, pollMs: 100 });
      // This fixture deliberately reuses the native client for a second turn;
      // production workers each detach their own client at exit.
      const shutdown = runtime.shutdown.bind(runtime); runtime.shutdown = async () => {};
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
      runtime.shutdown = shutdown;
      assert.equal(notifications.length, 2);
      assert.ok(calls.includes("max"));
    } finally {
      if (handle) await runtime.close({ handle, reason: "published fixture cleanup" }).catch(() => {});
      await runtime.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

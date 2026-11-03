/** Opt-in: fixed OpenCode, real config watchers, synthetic loopback Responses only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("published OpenCode: complete center skills load; an existing ACP session and a new session see synced updates", {
  skip: !process.env.OPENCODE_FIXTURE_BINARY || !process.env.AGENT_CONFIG_FIXTURE_SOURCE, timeout: 60000,
}, async () => {
  const base = process.env.AGENT_CONFIG_EVIDENCE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "config-published-"));
  fs.mkdirSync(base, { mode: 0o700, recursive: true }); fs.chmodSync(base, 0o700);
  const root = path.join(base, "toolset"), version = path.join(root, "version"), project = path.join(base, "project");
  for (const dir of [version, project, path.join(version, "node/bin"), path.join(root, "bin"),
    ...["home", "config", "data", "cache", "state", "tmp"].map((name) => path.join(root, "runtime", name))])
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  for (const name of fs.readdirSync(scripts).filter((name) => /\.(py|mjs)$/.test(name) || name === "profile-env.json"))
    fs.copyFileSync(path.join(scripts, name), path.join(version, name));
  fs.copyFileSync(process.execPath, path.join(version, "node/bin/node"));
  fs.copyFileSync(process.env.OPENCODE_FIXTURE_BINARY, path.join(version, "opencode"));
  fs.chmodSync(path.join(version, "opencode"), 0o700);
  fs.writeFileSync(path.join(version, "settings.json"), JSON.stringify({ install_root: root, workspace_id: "published-config", runtime_profile: "env" }), { mode: 0o600 });
  const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  for (const tool of ["opencode", "opencode-task"])
    fs.writeFileSync(path.join(root, "bin", tool), `#!/bin/bash\nexec python3 -B ${quote(path.join(version, "runtime.py"))} ${tool} "$@"\n`, { mode: 0o700 });
  const seed = spawnSync("python3", ["-B", fileURLToPath(new URL("./agent_config_fixture.py", import.meta.url)), root, version, "published-config"],
    { env: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp" }, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  const fixture = JSON.parse(seed.stdout), source = fixture.source;
  fs.rmSync(path.join(source, "skills"), { recursive: true });
  for (const name of fs.readdirSync(process.env.AGENT_CONFIG_FIXTURE_SOURCE))
    fs.cpSync(path.join(process.env.AGENT_CONFIG_FIXTURE_SOURCE, name), path.join(source, name), { recursive: true });
  const originalRules = fs.readFileSync(path.join(source, "AGENTS.md"), "utf8");
  const markerA = "CONFIG_SYNC_FIXTURE_RULE_A", markerB = "CONFIG_SYNC_FIXTURE_RULE_B";
  fs.writeFileSync(path.join(source, "AGENTS.md"), originalRules + `\n${markerA}\n`);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", source, ...args], { env: { PATH: "/usr/bin:/bin", HOME: base, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("add", "."); git("commit", "-m", "isolated actual center with marker A");
  const calls = [], outputs = [];
  let step = 0;
  const server = http.createServer((request, response) => {
    let input = ""; request.on("data", (value) => { input += value; }); request.on("end", () => {
      try {
        assert.ok(request.url.endsWith("/responses"));
        const body = JSON.parse(input); calls.push(body);
        fs.appendFileSync(path.join(base, "requests.jsonl"), input + "\n", { mode: 0o600 });
        const tools = body.tools || [];
        const main = body.reasoning?.effort !== "low";
        let item;
        if (main && step === 0) {
          const skill = tools.find((tool) => tool.name === "skill");
          assert.ok(skill, "native skill tool must be advertised");
          assert.match(body.instructions, /stop-that-shit/); assert.match(body.instructions, /stss/);
          step++;
          item = { id: "fc_skill", type: "function_call", call_id: "call_skill", name: "skill", arguments: JSON.stringify({ id: "stss" }), status: "completed" };
        } else if (main && step === 1) {
          step++;
          item = { id: "fc_reference", type: "function_call", call_id: "call_reference", name: "read", arguments: JSON.stringify({
            path: path.join(root, "runtime/config/opencode/skills/agent-config/stss/references/examples.md"),
          }), status: "completed" };
        } else {
          if (main) outputs.push(input);
          item = { id: "msg_" + randomUUID(), type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "Synthetic config load verified.", annotations: [] }] };
        }
        const id = "resp_" + randomUUID(), event = (value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        event({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
        event({ type: "response.output_item.added", output_index: 0,
          item: item.type === "function_call" ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
        if (item.type === "function_call") {
          event({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
          event({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
        } else {
          const text = item.content[0].text;
          event({ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          event({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text });
          event({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text });
        }
        event({ type: "response.output_item.done", output_index: 0, item });
        event({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
        response.end();
      } catch (error) { response.writeHead(500); response.end(); outputs.push(String(error)); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { PATH: fixture.path, HOME: base, TMPDIR: "/tmp", LANG: "C.UTF-8",
    CODEX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, CODEX_API_KEY: "synthetic-config-key",
    OPENCODE_DISABLE_MODELS_FETCH: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sync = () => {
    const result = spawnSync(path.join(root, "bin/opencode-task"), ["--help"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, "runtime/tasks-v3")), false);
  };
  sync();
  const actualSkills = ["stop-that-shit", "stss"];
  for (const name of actualSkills) {
    const original = path.join(process.env.AGENT_CONFIG_FIXTURE_SOURCE, "skills", name);
    const installed = path.join(root, "runtime/config/opencode/skills/agent-config", name);
    for (const relative of fs.readdirSync(original, { recursive: true }).filter((relative) => fs.statSync(path.join(original, relative)).isFile()))
      assert.deepEqual(fs.readFileSync(path.join(installed, relative)), fs.readFileSync(path.join(original, relative)));
  }
  const child = spawn(path.join(root, "bin/opencode"), ["acp"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", nextId = 0, stderr = "";
  const pending = new Map();
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdout.on("data", (data) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "session/request_permission") {
        const option = message.params.options.find((option) => option.kind === "allow_once") || message.params.options[0];
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } }) + "\n");
      } else if (message.id != null && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
      }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`ACP timeout: ${method}; ${stderr.slice(-1000)}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const prompt = (sessionId) => rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "Synthetic fixture: inspect loaded instructions and skills." }] });
  try {
    await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "config-sync-fixture", version: "1" } });
    const session = await rpc("session/new", { cwd: project, mcpServers: [] });
    await prompt(session.sessionId);
    const first = calls.filter((body) => body.reasoning?.effort !== "low");
    assert.ok(JSON.stringify(first).includes(markerA));
    assert.ok(outputs.some((body) => body.includes("function_call_output") && body.includes("stss")), "skill content must return through the real tool");
    const referenceLine = fs.readFileSync(path.join(source, "skills/stss/references/examples.md"), "utf8").split("\n").find((line) => line.length > 20);
    assert.ok(calls.some((body) => body.input?.some((item) => item.type === "function_call_output" &&
      item.call_id === "call_reference" && item.output.includes(referenceLine))), "skill reference content must load through the real read tool");
    fs.writeFileSync(path.join(source, "AGENTS.md"), originalRules + `\n${markerB}\n`);
    const reload = path.join(source, "skills/reload-fixture"); fs.mkdirSync(reload);
    fs.writeFileSync(path.join(reload, "SKILL.md"), "---\nname: reload-fixture\ndescription: Reload fixture discovered after synchronization.\n---\nSynthetic reload content.\n");
    git("add", "."); git("commit", "-m", "isolated marker B and new skill");
    sync();
    await pause(800); // Native watcher debounce is 100 ms; no daemon or process restart.
    const prior = calls.length;
    await prompt(session.sessionId);
    const continued = calls.slice(prior).filter((body) => body.reasoning?.effort !== "low");
    assert.ok(JSON.stringify(continued).includes(markerB), "same session must receive updated global instructions");
    assert.ok(JSON.stringify(continued).includes("reload-fixture"), "same session must receive updated skill discovery");
    const newSession = await rpc("session/new", { cwd: project, mcpServers: [] }), beforeNew = calls.length;
    await prompt(newSession.sessionId);
    assert.ok(JSON.stringify(calls.slice(beforeNew)).includes(markerB), "new session must receive updated global instructions");
    assert.ok(!JSON.stringify(calls.slice(beforeNew)).includes(markerA), "new session must start with the latest rules");
    console.log(JSON.stringify({ binary: "v2.2.0-ricky.1", complete_skills: actualSkills, real_skill_tool: true,
      existing_session_next_request: "updated", new_session: "updated", business_tasks_created: false, evidence: path.join(base, "requests.jsonl") }));
  } finally {
    for (const { timer } of pending.values()) clearTimeout(timer);
    const exit = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM");
    await Promise.race([exit, pause(2000)]); if (child.exitCode == null && child.signalCode == null) { child.kill("SIGKILL"); await exit; }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.writeFileSync(path.join(base, "opencode.stderr"), stderr, { mode: 0o600 });
    if (!process.env.AGENT_CONFIG_EVIDENCE_DIR) fs.rmSync(base, { recursive: true, force: true });
  }
});

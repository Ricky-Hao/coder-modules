/** Cross-repository fixture: the production worker emits its exact wire body. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../scripts/task.mjs";
import { TaskWorker } from "../scripts/task-worker.mjs";
import { readyTask, mockRuntime } from "./task-fixture.mjs";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "callback-protocol-")); fs.chmodSync(root, 0o700);
try {
  const store = new TaskStore(root), task = readyTask(store, { key: "protocol-integration", prompt: "Complete the fixture task.", callback: input });
  const runtime = mockRuntime(task), start = runtime.startTurn;
  runtime.startTurn = (turn) => {
    if (turn.text.includes(input.callback_id)) throw new Error("Callback leaked to prompt");
    const result = start(turn);
    runtime.push({ type: "message", message: { params: { update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Module result accepted across repositories." } } } } });
    runtime.push({ type: "turn_result", result: { status: input.result ?? "completed" } });
    return result;
  };
  await new TaskWorker(store, { runtime }).run(task);
  console.log(JSON.stringify({ ...store.summary(task), executions: runtime.starts }));
  if (store.outbox(task).state !== "delivered") process.exitCode = 1;
} finally { fs.rmSync(root, { recursive: true, force: true }); }

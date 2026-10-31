/** Cross-repository fixture: production TaskRunner emits the real callback body. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskRunner } from "../scripts/task.mjs";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "callback-protocol-"));
fs.chmodSync(root, 0o700);
let executions = 0;
let requestId;
const runtime = {
  async ensureSession(input) {
    return {
      sessionKey: input.sessionKey,
      cwd: input.cwd,
      acpxRecordId: "cross-repo-record",
      backend: "acpx-shared",
      runtimeSessionName: "cross-repo",
    };
  },
  startTurn(turn) {
    executions++;
    requestId = turn.requestId;
    if (turn.text.includes(input.callback_id))
      throw new Error("Callback leaked to prompt");
    return {
      promptStarted: Promise.resolve(),
      events: (async function* () {
        yield {
          type: "text_delta",
          stream: "output",
          text: "Module result accepted across repositories.",
        };
      })(),
      result: Promise.resolve({ status: input.result ?? "completed" }),
    };
  },
  async *watchSession() {
    yield { type: 'message', requestId, cursor: '0', message: { params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Module result accepted across repositories.' } } } } };
    yield { type: 'turn_result', requestId, cursor: '1', result: { status: input.result ?? 'completed' } };
  },
};
try {
  const runner = new TaskRunner({ root, runtime });
  const accepted = runner.submit({
    model: { id: 'fixture/test' }, modelConfig: path.join(root, 'config.json'), modelProfile: 'external',
    key: "protocol-integration",
    prompt: "Complete the fixture task.",
    cwd: root,
    callback: input,
  });
  await runner.execute(accepted.task_id);
  await runner.deliver(runner.load(accepted.task_id));
  console.log(
    JSON.stringify({ ...runner.status(accepted.task_id), executions }),
  );
  if (runner.status(accepted.task_id).state !== "delivered")
    process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true });
}

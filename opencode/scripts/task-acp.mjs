/** Version-bound adapter. Public runtime for execution/watch; the same pinned
 * request-targeted cancellation primitive used by SharedAcpRuntimeTurn.cancel
 * also serves recovered turns. Never call session-wide runtime.cancel. */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createSharedAcpRuntime, createAgentRegistry } from "acpx/runtime";
import { t as tryCancelOnRunningOwner } from "acpx/dist/ipc-BbYFsKOj.js";
import { taskPermissions, taskModel, privateFile } from "./task.mjs";

const installed = createRequire(import.meta.url)("acpx/package.json").version;
export function createTaskRuntime(root, record) {
  if (installed !== "0.21.1") throw new Error("UNSUPPORTED_ACPX_RUNTIME");
  const permissions = taskPermissions(
    record.permissions?.mode,
    record.permissions?.policy,
  );
  const model = taskModel(record.model);
  const argv = [path.join(root, "bin/opencode")];
  if (model) {
    privateFile(record.modelConfig);
    argv.push("--module-task", record.modelConfig, model.id, model.variant ?? "", record.modelProfile);
  }
  argv.push("acp");
  const runtime = createSharedAcpRuntime({
    cwd: record.cwd,
    agentRegistry: createAgentRegistry({
      overrides: { opencode: argv },
    }),
    permissionMode: permissions.mode,
    permissionPolicy: permissions.policy,
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
  });
  if (model) {
    const ensure = runtime.ensureSession.bind(runtime);
    runtime.ensureSession = async (input) => {
      if (!process.env.OPENCODE_MODULE_SESSION_LOCK)
        throw new Error("SESSION_SELECTION_LOCK_REQUIRED");
      const fd = Number(process.env.OPENCODE_MODULE_SESSION_LOCK);
      try {
        const existing = await runtime.findSession(input);
        if (existing) {
          const proof = JSON.parse(fs.readFileSync(fd, "utf8") || "null");
          if (proof?.acpxRecordId !== existing.acpxRecordId ||
              JSON.stringify(proof.model) !== JSON.stringify(model))
            throw new Error("SESSION_MODEL_UNCONFIRMED");
          return existing; // No control requests while another task runs or queues.
        }
        const handle = await ensure({ ...input, sessionOptions: { model: model.id } });
        // The private config supplies the initial variant. Verify the agent's ACP
        // acknowledgement before any prompt; shared controls require a live owner.
        const status = await runtime.getStatus({ handle });
        if (status.models?.currentModelId !== model.id || (model.variant !== undefined &&
            !status.details?.configOptions?.some((option) => option.id === "effort" && option.currentValue === model.variant)))
          throw new Error("SESSION_MODEL_UNCONFIRMED");
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, JSON.stringify({ acpxRecordId: handle.acpxRecordId, model }), 0, "utf8");
        fs.fsyncSync(fd);
        return handle;
      } finally {
        fs.closeSync(fd);
        delete process.env.OPENCODE_MODULE_SESSION_LOCK;
      }
    };
  }
  runtime.cancelRequest = async ({ handle, requestId }) => {
    if (
      handle.backend !== "acpx-shared" ||
      handle.cwd !== record.cwd ||
      handle.sessionKey !== record.sessionKey ||
      !handle.acpxRecordId ||
      requestId !== record.requestId
    )
      throw new Error("SESSION_IDENTITY_CONFLICT");
    return tryCancelOnRunningOwner({
      sessionId: handle.acpxRecordId,
      targetRequestId: requestId,
    });
  };
  return runtime;
}

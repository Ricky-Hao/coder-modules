/** Version-bound adapter. Public runtime for execution/watch; the same pinned
 * request-targeted cancellation primitive used by SharedAcpRuntimeTurn.cancel
 * also serves recovered turns. Never call session-wide runtime.cancel. */
import path from "node:path";
import { createRequire } from "node:module";
import { createSharedAcpRuntime, createAgentRegistry } from "acpx/runtime";
import { t as tryCancelOnRunningOwner } from "acpx/dist/ipc-BW06Pbb8.js";
import { taskPermissions } from "./task.mjs";

const installed = createRequire(import.meta.url)("acpx/package.json").version;
export function createTaskRuntime(root, record) {
  if (installed !== "0.19.3") throw new Error("UNSUPPORTED_ACPX_RUNTIME");
  const permissions = taskPermissions(
    record.permissions?.mode,
    record.permissions?.policy,
  );
  const runtime = createSharedAcpRuntime({
    cwd: record.cwd,
    agentRegistry: createAgentRegistry({
      overrides: { opencode: [path.join(root, "bin/opencode"), "acp"] },
    }),
    permissionMode: permissions.mode,
    permissionPolicy: permissions.policy,
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
  });
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

/** 固定版本适配器：原生执行/观察及请求级取消。socket/generation 只用于取消隔离。 */
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createSharedAcpRuntime, createAgentRegistry } from "acpx/runtime";
import { l as readQueueOwnerRecord } from "acpx/dist/ipc-BbYFsKOj.js";
import { taskPermissions, taskModel, privateFile } from "./task.mjs";

const installed = createRequire(import.meta.url)("acpx/package.json").version;
async function cancelOriginal(recordId, targetRequestId) {
  const owner = await readQueueOwnerRecord(recordId);
  if (!owner) return false;
  const hash = (text, size) => createHash("sha256").update(text).digest("hex").slice(0, size);
  const expected = `/tmp/acpx-${hash(os.homedir(), 10)}/${hash(recordId, 24)}.sock`;
  if (owner.socketPath !== expected) throw new Error("UNSAFE_OWNER_SOCKET");
  const parent = fs.lstatSync(path.dirname(expected));
  const socketInfo = fs.lstatSync(expected);
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077 ||
      !socketInfo.isSocket() || socketInfo.uid !== process.getuid()) throw new Error("UNSAFE_OWNER_SOCKET");
  const requestId = randomUUID();
  // 直接取消原 request；原生 helper 的健康回退可能清理不可确认的 owner。
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(expected);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(new Error("CANCEL_UNCONFIRMED")) : resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => finish(true));
    socket.once("error", () => finish(true));
    socket.once("connect", () => socket.write(JSON.stringify({
      type: "cancel_prompt", requestId, targetRequestId, ownerGeneration: owner.ownerGeneration,
    }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4096) return finish(true);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let response;
        try { response = JSON.parse(buffer.slice(0, newline)); } catch { return finish(true); }
        buffer = buffer.slice(newline + 1);
        if (response.requestId !== requestId || response.ownerGeneration !== owner.ownerGeneration) return finish(true);
        if (response.type === "accepted") continue;
        if (response.type === "cancel_result" && typeof response.cancelled === "boolean") return finish(false, response.cancelled);
        return finish(true);
      }
    });
    socket.once("close", () => finish(true));
  });
}
export function createTaskRuntime(root, record) {
  if (installed !== "0.21.1") throw new Error("UNSUPPORTED_ACPX_RUNTIME");
  const permissions = taskPermissions(
    record.permissions.mode,
    record.permissions.policy,
  );
  const model = taskModel(record.model);
  privateFile(record.modelConfig);
  const argv = [path.join(root, "bin/opencode"), "--module-task", record.modelConfig,
    model.id, model.variant ?? "", record.modelProfile, "acp"];
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
  const ensure = runtime.ensureSession.bind(runtime);
  runtime.ensureSession = async (input) => {
    const existing = await runtime.findSession(input);
    if (record.continuationHandle) {
      if (!existing || ["acpxRecordId", "backendSessionId", "cwd", "sessionKey", "backend"]
          .some((name) => existing[name] !== record.continuationHandle[name])) throw new Error("SESSION_IDENTITY_CONFLICT");
      return existing; // 可信续接沿原选择，不控制正在运行或排队的 turn。
    }
    if (existing) throw new Error("SESSION_IDENTITY_CONFLICT"); // 不接管手工 session。
    const handle = await ensure({ ...input, sessionOptions: { model: model.id } });
    const status = await runtime.getStatus({ handle });
    if (status.models?.currentModelId !== model.id || (model.variant !== undefined &&
        !status.details?.configOptions?.some((option) => option.id === "effort" && option.currentValue === model.variant)))
      throw new Error("SESSION_MODEL_UNCONFIRMED");
    return handle;
  };
  runtime.cancelRequest = async ({ handle, requestId }) => {
    if (
      handle.backend !== "acpx-shared" ||
      handle.cwd !== record.cwd ||
      handle.sessionKey !== record.sessionKey ||
      !handle.acpxRecordId ||
      requestId !== record.requestId
    )
      throw new Error("SESSION_IDENTITY_CONFLICT");
    return cancelOriginal(handle.acpxRecordId, requestId);
  };
  return runtime;
}

/** 固定版本适配器：原生执行/观察、只读 lease/进程出生证据及请求级取消；探测不清理 owner。 */
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createSharedAcpRuntime, createAgentRegistry } from "acpx/runtime";
import {
  l as readQueueOwnerRecord,
  E as observeProcessIncarnation,
} from "acpx/dist/ipc-BbYFsKOj.js";
import { taskPermissions, taskModel, privateFile } from "./task.mjs";

const installed = createRequire(import.meta.url)("acpx/package.json").version;
// 不清理 lease、发送信号、连接第二个 agent 或提交队列控制。
export async function observeOwner(recordId) {
  const owner = await readQueueOwnerRecord(recordId);
  if (!owner) return { owner: "unavailable", process: "unknown" };
  const incarnation = await observeProcessIncarnation(owner.pid, owner.processIdentity);
  const current = await readQueueOwnerRecord(recordId);
  if (current?.ownerGeneration !== owner.ownerGeneration || current?.pid !== owner.pid)
    return { owner: "unknown", process: "unknown" };
  const heartbeatAt = Date.parse(owner.heartbeatAt);
  const age = Date.now() - heartbeatAt;
  const fresh = Number.isFinite(heartbeatAt) && age >= 0 && age <= 15000;
  return {
    owner: incarnation === "matching" && fresh ? "lease_current" : "unavailable",
    process: incarnation === "matching" ? "alive" : incarnation,
    generation: owner.ownerGeneration,
    heartbeatAt: Number.isSafeInteger(heartbeatAt) ? heartbeatAt : undefined,
  };
}

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
    if (!process.env.OPENCODE_MODULE_SESSION_LOCK)
      throw new Error("SESSION_SELECTION_LOCK_REQUIRED");
    const fd = Number(process.env.OPENCODE_MODULE_SESSION_LOCK);
    try {
      const existing = await runtime.findSession(input);
      if (record.continuationHandle && (!existing || ["acpxRecordId", "backendSessionId", "cwd", "sessionKey", "backend"]
          .some((name) => existing[name] !== record.continuationHandle[name])))
        throw new Error("SESSION_IDENTITY_CONFLICT");
      if (existing) {
        const proof = JSON.parse(fs.readFileSync(fd, "utf8") || "null");
        if (proof?.acpxRecordId !== existing.acpxRecordId ||
            JSON.stringify(proof.model) !== JSON.stringify(model))
          throw new Error("SESSION_MODEL_UNCONFIRMED");
        return existing; // 其他任务运行或排队时不发送选择控制。
      }
      const handle = await ensure({ ...input, sessionOptions: { model: model.id } });
      // 私有配置提供初始 variant；发送 prompt 前核对 ACP 确认。
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
  runtime.observeOwner = ({ handle }) => observeOwner(handle.acpxRecordId);
  return runtime;
}

/** 可信本地 task store 的有界只读查询；不恢复、不初始化。 */
import fs from "node:fs";
import { TaskError, errorCode, errorInfo } from "./task-errors.mjs";

export const RECORD_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_BYTES = 16384;

export function readJson(filename, maximum = RECORD_BYTES, { optional = false, stage = "read", field = "task_record",
  invalidCode = "INVALID_TASK_RESULT", readCode } = {}) {
  try {
    if (fs.statSync(filename).size > maximum) throw new Error("TASK_RECORD_TOO_LARGE");
    const text = fs.readFileSync(filename, "utf8");
    if (Buffer.byteLength(text) > maximum) throw new Error("TASK_RECORD_TOO_LARGE");
    try { return JSON.parse(text); }
    catch { throw new Error(invalidCode); }
  } catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    const code = readError(error);
    throw new TaskError(readCode && ["TASK_NOT_FOUND", "TASK_READ_FAILED"].includes(code) ? readCode : code, { stage, field, reason: error?.code });
  }
}
export function readError(error) {
  return errorCode(error, error?.code === "ENOENT" ? "TASK_NOT_FOUND" : "TASK_READ_FAILED");
}

export function listTasks(runner, flags = {}) {
  const limit = flags["--limit"] ?? "20", state = flags["--state"], session = flags["--session"];
  const fail = (field) => { throw new TaskError("INVALID_ARGUMENTS", { stage: "list", field }); };
  if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50) fail("limit");
  if (state !== undefined && !["queued", "preparing", "dispatching", "running", "ambiguous", "completed"].includes(state)) fail("state");
  if (session !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session) || session.includes("tcb_"))) fail("session");
  const items = [], errors = [];
  const ids = fs.readdirSync(runner.root).filter((id) => /^task_[a-f0-9]{64}$/.test(id)).sort();
  // 小型单人 store；一次最多读取 200 条，返回最多 50 条，无游标或全库索引。
  const selected = ids.slice(0, 200);
  let checked = 0;
  for (const id of selected) {
    checked++;
    try {
      const record = runner.load(id);
      const { evidence, ...item } = runner.resultRecord(record, { output: false });
      if ((state === undefined || item.state === state) && (session === undefined || item.session_name === session)) items.push(item);
    } catch (error) { errors.push(errorInfo(readError(error), { stage: "read", field: "task_record", task_id: id })); }
    if (items.length === Number(limit)) break;
  }
  return { version: 1, items, errors, truncated: checked < ids.length, records_checked: checked };
}

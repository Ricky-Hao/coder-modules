/** 只读任务查询。 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const RECORD_BYTES = 8 * 1024 * 1024;
export const PAGE_BYTES = 32 * 1024 * 1024;
export const SNAPSHOT_BYTES = 16384;
const states = ["queued", "preparing", "dispatching", "running", "ambiguous", "completed"];

export function readJson(filename, maximum = RECORD_BYTES, { budget, optional = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === "ENOENT" && optional) return undefined;
      if (error.code === "ELOOP") throw new Error("UNSAFE_TASK_FILE");
      throw error;
    }
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077)
        throw new Error("UNSAFE_TASK_FILE");
      if (info.nlink === 0) continue;
      if (info.nlink !== 1) throw new Error("UNSAFE_TASK_FILE");
      if (info.size > maximum) throw new Error("TASK_RECORD_TOO_LARGE");
      if (budget && budget.remaining < info.size + 1) throw new Error("TASK_READ_BUDGET");
      const capacity = info.size + 1;
      const buffer = Buffer.alloc(capacity);
      let count = 0;
      while (count < capacity) {
        const received = fs.readSync(fd, buffer, count, capacity - count, null);
        if (!received) break;
        count += received;
      }
      if (budget) budget.remaining -= count;
      if (count > maximum) throw new Error("TASK_RECORD_TOO_LARGE");
      if (count === capacity) throw new Error("TASK_RECORD_CHANGED");
      try { return JSON.parse(buffer.subarray(0, count).toString("utf8")); }
      catch { throw new Error("INVALID_TASK_RESULT"); }
    } finally { fs.closeSync(fd); }
  }
  throw new Error("TASK_RECORD_CHANGED");
}

export function readError(error) {
  const known = ["UNSAFE_TASK_FILE", "UNSAFE_TASK_DIRECTORY", "INVALID_TASK_RESULT", "INVALID_TASK_ID",
    "TASK_RECORD_TOO_LARGE", "TASK_READ_BUDGET", "TASK_RECORD_CHANGED", "CURSOR_STALE", "INVALID_CURSOR",
    "INVALID_ARGUMENTS", "TASK_DIRECTORY_UNREADABLE", "UNSUPPORTED_TASK_RECORD", "UNSUPPORTED_SESSION_RECORD"];
  if (known.includes(error.message)) return error.message;
  if (error.code === "ENOENT") return "TASK_NOT_FOUND";
  if (["ELOOP", "ENOTDIR"].includes(error.code)) return "UNSAFE_TASK_DIRECTORY";
  return "TASK_READ_FAILED";
}

function integer(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]{0,3}$/.test(value) || Number(value) > maximum) throw new Error("INVALID_ARGUMENTS");
  return Number(value);
}

function decodeCursor(value, filter) {
  if (value === undefined) return null;
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw 0;
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed.version !== 1 || parsed.filter !== filter || !Array.isArray(parsed.directory) ||
        parsed.directory.length !== 4 || parsed.directory.some((part) => !/^[0-9]{1,20}$/.test(part)) ||
        !/^[0-9]{1,19}$/.test(parsed.position) || BigInt(parsed.position) > 9223372036854775807n) throw 0;
    return parsed;
  } catch { throw new Error("INVALID_CURSOR"); }
}

export function listTasks(runner, flags = {}) {
  const limit = integer(flags["--limit"], 20, 50);
  const scanLimit = integer(flags["--scan-limit"], 100, 200);
  const state = flags["--state"];
  const session = flags["--session"];
  if (state !== undefined && !states.includes(state) || session !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session) || session.includes("tcb_")))
    throw new Error("INVALID_ARGUMENTS");
  const filter = createHash("sha256").update(JSON.stringify([state ?? null, session ?? null])).digest("hex");
  const cursor = decodeCursor(flags["--cursor"], filter);
  const helper = spawnSync("python3", ["-B", fileURLToPath(new URL("./diagnostics.py", import.meta.url)),
    "_page", runner.root, JSON.stringify(cursor), String(scanLimit)],
  { encoding: "utf8", timeout: 5000, maxBuffer: 65536, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" } });
  let page;
  try { page = JSON.parse(helper.stdout); }
  catch { throw new Error("TASK_DIRECTORY_UNREADABLE"); }
  if (helper.status !== 0) throw new Error(page.error?.code === "CURSOR_STALE" ? "CURSOR_STALE" : "TASK_DIRECTORY_UNREADABLE");
  const items = [], errors = [];
  const budget = { remaining: PAGE_BYTES };
  let scanned = 0, checked = 0, position = cursor?.position ?? "0", stopped = null;
  for (const entry of page.entries) {
    if (entry.id) {
      try {
        const record = runner.load(entry.id, { budget });
        const summary = runner.resultRecord(record, { output: false });
        checked++;
        if ((state === undefined || summary.state === state) && (session === undefined || summary.session_name === session)) {
          const { evidence, ...item } = summary;
          items.push(item);
        }
      } catch (error) {
        if (error.message === "TASK_READ_BUDGET") { stopped = "read_budget"; break; }
        errors.push({ task_id: entry.id, code: readError(error) });
      }
    }
    scanned++;
    position = entry.position;
    if (items.length === limit) { stopped = "limit"; break; }
  }
  const exhausted = !stopped && page.ended;
  const next = exhausted ? null : Buffer.from(JSON.stringify({ version: 1, filter,
    directory: page.directory, position })).toString("base64url");
  return { version: 1, items, errors, coverage: {
    directory_entries_read: page.entries.length, entries_scanned: scanned, records_checked: checked,
    records_failed: errors.length, record_bytes_read: PAGE_BYTES - budget.remaining,
    limit, scan_limit: scanLimit, record_limit_bytes: RECORD_BYTES, page_read_limit_bytes: PAGE_BYTES,
    exhausted, complete: exhausted && errors.length === 0, stop_reason: stopped ?? (exhausted ? "end" : "scan_limit"),
    remaining_records: null, consistency: "per_record_samples",
  }, next_cursor: next };
}

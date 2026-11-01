/** launch/status 共用的小型回执投影。内部证明、prompt 和 callback 不公开。 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readJson } from "./task-read.mjs";
import { taskModel, taskPermissions } from "./task.mjs";
import { TaskError } from "./task-errors.mjs";

export const launchStages = new Set(["claimed", "fetch", "branch", "worktree_directory", "worktree", "input", "submit", "accepted"]);
const taskId = (id) => typeof id === "string" && /^task_[a-f0-9]{64}$/.test(id);
const clean = (text, max) => typeof text === "string" && text.length > 0 && text.length <= max && !/[\x00-\x1f\x7f]|tcb_|:\/\//.test(text);
const absolute = (text) => clean(text, 4096) && path.isAbsolute(text) && path.normalize(text) === text;
export const branchName = (name) => clean(name, 240) && name !== "HEAD" && !name.includes("..") && name.split("/").every((part) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".") && !part.endsWith(".lock"));
export const launchProof = (record) => ({ inputHash: record.inputHash, origin: record.origin });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () => { throw new TaskError("INVALID_TASK_RESULT", { stage: "read", field: "launch_record" }); };

export function loadLaunch(root, id, optional = false) {
  if (!taskId(id)) throw new TaskError("INVALID_TASK_ID", { stage: "read", field: "task_id" });
  const record = readJson(path.join(root, ".launches", `${id}.json`), 65536, { optional, field: "launch_record" });
  if (record === undefined) return;
  if (record?.version !== 3) throw new TaskError("UNSUPPORTED_LAUNCH_RECORD", { stage: "read", field: "launch_record" });
  if (record.id !== id || !clean(record.key, 256) || `task_${createHash("sha256").update(record.key).digest("hex")}` !== id ||
      !/^[a-f0-9]{64}$/.test(record.inputHash) || !taskId(record.origin) || !taskId(record.tail) || !launchStages.has(record.stage) ||
      !absolute(record.repo_path) || !absolute(record.worktree) || !absolute(record.repository?.common) ||
      !branchName(record.branch) || !branchName(record.base) || record.session !== `launch-${record.origin.slice(5)}` ||
      record.prior !== undefined && !taskId(record.prior) || record.controlAck !== undefined && typeof record.controlAck !== "boolean" ||
      record.base_sha !== undefined && !/^[a-f0-9]{40}$/.test(record.base_sha) ||
      !["claimed", "fetch"].includes(record.stage) && !record.base_sha ||
      !Number.isSafeInteger(record.noProgressMs) || record.noProgressMs < 1000 || record.noProgressMs > 86400000) invalid();
  try {
    if (!record.permissions?.mode || !record.permissions.policy) invalid();
    taskPermissions(record.permissions.mode, record.permissions.policy);
    if (record.selection) {
      taskModel(record.selection.model);
      if (!absolute(record.selection.modelConfig) || !["env", "external"].includes(record.selection.modelProfile)) invalid();
    } else if (record.stage !== "claimed") invalid();
  } catch { invalid(); }
  return record;
}
export function verifyLaunchTask(record, task) {
  if (!same(task.launch, launchProof(record)) || task.cwd !== record.worktree || task.sessionName !== record.session ||
      !same(task.permissions, record.permissions) || !same(task.model, record.selection?.model) ||
      task.modelConfig !== record.selection?.modelConfig || task.modelProfile !== record.selection?.modelProfile) invalid();
}
export function permissionSummary({ mode, policy }) {
  const rules = ["autoApprove", "autoDeny", "escalate"].map((name) => policy[name] ?? []);
  const visible = rules.map((values) => values.filter((rule) => ["*", "read", "edit", "write", "execute"].includes(rule)));
  return { mode, policy_rules: rules.flat().length, default_action: policy.defaultAction ?? null,
    auto_approve: visible[0], auto_deny: visible[1], escalate: visible[2], rules_withheld: rules.flat().length - visible.flat().length };
}
export function launchProjection(record, root) {
  const model = record.selection?.model;
  return { key: record.key, task_id: record.id, stage: record.stage, repo_path: record.repo_path, branch: record.branch, worktree: record.worktree,
    base: record.base, base_sha: record.base_sha ?? null, session: record.session, continue_from: record.prior ?? null,
    selection: model ? { provider: model.id.split("/")[0], model: model.id.split("/").slice(1).join("/"), variant: model.variant ?? null, status: "resolved" } : null,
    permissions: permissionSummary(record.permissions), no_progress_timeout_seconds: record.noProgressMs / 1000,
    ...queryLocation(root, record.id) };
}
export function queryLocation(root, id) {
  const command = "'" + path.resolve(root, "../../bin/opencode-task").replaceAll("'", "'\"'\"'") + "'";
  return { query: { status: `${command} status ${id}`, result: `${command} result ${id}`, task_directory: path.join(root, id) } };
}
export function receiptFacts(task, { taskRecorded = Boolean(task), claimRecorded = false, dispatchUncertain = false, preparationUncertain = false } = {}) {
  const dispatch = task?.dispatchedAt ? "attempted" : dispatchUncertain ? "unknown" : "not_reached";
  const scope = [...(preparationUncertain ? ["preparation"] : []), ...(taskRecorded === null || claimRecorded === null ? ["storage"] : []),
    ...(dispatch === "unknown" || task && !task.result ? ["request"] : [])];
  return { task_recorded: taskRecorded, claim_recorded: claimRecorded, dispatch_state: dispatch, unknown_scope: scope, outcome_unknown: scope.length > 0 };
}
export function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX", "GIT_SHALLOW_FILE",
  ].includes(name)));
}
export function preparationSummary(record) {
  const result = spawnSync("git", ["-C", record.repo_path, "show-ref", "--verify", "--quiet", `refs/heads/${record.branch}`],
    { env: gitEnvironment(), timeout: 3000, stdio: "ignore" });
  return { policy: "fail_closed_on_partial_git_preparation", objects: { repository: fs.existsSync(record.repo_path),
    branch: result.status === 0 ? true : result.status === 1 ? false : null, worktree_directory: fs.existsSync(record.worktree),
    git_worktree: "not_checked", backend_session: "not_checked" }, action: "inspect_preparation",
    hint: "人工核对原输入和 Git 现场；无完整 task 时 recover 不适用。同 key 不自动续完，不换 key 重派，不自动清理。" };
}

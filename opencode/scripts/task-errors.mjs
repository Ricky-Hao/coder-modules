/** 任务层安全错误。只保留固定分类；不保存底层 message、cause 或 stack。 */
const definitions = {
  INVALID_COMMAND: ["input", "fix_input", "核对 --help 中的公开命令。"],
  INVALID_ARGUMENTS: ["input", "fix_input", "核对 --help 中的参数名称、数量和范围。"],
  INVALID_SUBMIT: ["input", "fix_input", "核对内部提交的 key/prompt 契约；公开入口仅为 launch。"],
  INVALID_CWD: ["input", "fix_input", "任务 cwd 须为可访问的绝对目录；不改向其他 checkout。"],
  INVALID_SESSION: ["input", "fix_input", "session 名称不符合绑定契约；公开 launch 不接受手工 session。"],
  INVALID_MODEL_PROFILE: ["configuration", "check_configuration", "任务 profile 须为 env 或 external；保留原选择，不迁移旧记录。"],
  INVALID_RESULT: ["input", "inspect_result", "任务结果状态不符合契约；不伪造成功或重派。"],
  INVALID_LAUNCH_INPUT: ["input", "fix_input", "修正所列字段或字段组合；不要把私密注册内容放入其他字段。"],
  INVALID_LAUNCH_JSON: ["input", "fix_input", "输入文件不是有效 JSON；修正文件编码或 JSON 语法。"],
  LAUNCH_INPUT_UNREADABLE: ["storage", "inspect_record", "核对私有输入文件是否存在、可读且路径安全；尚未进入 Git 准备。"],
  INVALID_CALLBACK: ["input", "fix_input", "核对原生 callback 注册的字段、URL 契约和输出限额；不要输出注册内容。"],
  CALLBACK_IN_PROMPT: ["input", "fix_input", "从业务 prompt 中移除 callback 私密内容；保留原注册。"],
  INVALID_PERMISSIONS: ["input", "fix_input", "核对 permissions 的模式和 policy 规则；修正格式不等于获得放权授权。"],
  INVALID_NO_PROGRESS_TIMEOUT: ["input", "fix_input", "no_progress_timeout_seconds 须为 1～86400 的整数，省略为 900。"],
  INVALID_MODEL: ["input", "fix_input", "核对 provider/model 选择和完整模型定义；不要自动切换模型。"],
  INVALID_VARIANT: ["input", "fix_input", "核对 variant 是否由所选模型支持；不要改变已绑定 session 的选择。"],
  LAUNCH_SELECTION_INVALID: ["unknown", "check_configuration", "选择或配置解析失败，底层类别未知；核对所列字段，不自动换模型或重派。"],
  LAUNCH_ENVIRONMENT_INVALID: ["configuration", "check_environment", "通过已有 Secret/env 机制修正所列变量；不要输出值，也不要回退 Provider。"],
  TASK_MODEL_CONFIG_REQUIRED: ["configuration", "check_configuration", "任务需要完整模型配置；核对 profile 或外部配置，不替换已保存的选择。"],
  TASK_TITLE_LOW_UNAVAILABLE: ["configuration", "check_configuration", "完整模型配置须支持 title 的 low variant；不改变主请求路由。"],
  LAUNCH_CONFLICT: ["input", "inspect_record", "同 key 已有不同输入；保留原输入和关联，先核对原 launch，不换 key 重派。"],
  SUBMIT_CONFLICT: ["storage", "inspect_record", "已有 task 与提交意图不一致；保留原记录，核对关联，不再次 submit。"],
  LAUNCH_METADATA_REQUIRED: ["storage", "inspect_record", "缺少可信 launch/task 关联；保留记录，不手工 adopt session 或重派。"],
  CONTINUE_BUSY_OR_UNKNOWN: ["unknown", "observe_original", "原请求尚无可信终态；用 status/result 观察原 task，不启动第二个写入者。"],
  CONTINUE_NOT_LATEST: ["input", "inspect_record", "续接须使用最新可信轮次；先核对原关联。"],
  CONTINUE_SESSION_UNCONFIRMED: ["unknown", "observe_original", "原 backend session 身份未确认；观察原请求，不建立替代 session。"],
  LAUNCH_OBJECT_CONFLICT: ["storage", "inspect_preparation", "Git 身份、分支或目录冲突；保留现场，人工核对，不覆盖、清理或换名称。"],
  GIT_PREPARATION_INTERRUPTED: ["unknown", "inspect_preparation", "准备 claim 没有完整 task 关联；人工核对 Git 和记录，不自动续完、清理或重派。"],
  GIT_REPOSITORY_INVALID: ["input", "inspect_preparation", "核对 repo_path 是否为安全 Git 顶层且有 origin；不输出 remote 或 stderr。"],
  GIT_FETCH_FAILED: ["unknown", "inspect_preparation", "origin base 的 fresh fetch 失败；核对 base 和 Git 访问，根因未知，不采用缓存或自动重试准备。"],
  GIT_PREPARE_FAILED: ["unknown", "inspect_preparation", "Git 准备失败，根因未知；保留分支、目录和 claim，人工核对现场。"],
  CONTROL_START_FAILED: ["runtime", "observe_original", "控制进程未能启动；task 可能已持久接受，先查原 task，必要时显式 recover。"],
  CONTROL_ACK_UNKNOWN: ["unknown", "observe_original", "未确认控制进程 ACK；可能已经派发。查原 task，必要时显式 recover，不杀进程或重发 prompt。"],
  MODEL_OR_SESSION_SETUP_FAILED: ["unknown", "check_configuration", "prompt 尚未派发；初始化失败的底层类别未知。核对保存的配置和 session，不自动放权或换模型。"],
  SESSION_MODEL_CONFLICT: ["input", "inspect_record", "session 固定模型/profile/variant；保留原选择，不控制切换或建立替代 session。"],
  SESSION_CWD_CONFLICT: ["input", "inspect_record", "session 的 cwd 绑定冲突；保留原关联，不接管其他 session。"],
  SESSION_IDENTITY_CONFLICT: ["unknown", "inspect_record", "backend session 身份缺失或变化；保留原请求，不建新 session 替代。"],
  SESSION_MODEL_UNCONFIRMED: ["configuration", "check_configuration", "ACP 未确认保存的 model/effort；不发 prompt，不自动切模型。"],
  UNSUPPORTED_ACPX_RUNTIME: ["configuration", "check_installation", "核对固定 acpx 0.21.1 安装；不要替换 active toolset 来重派任务。"],
  RECOVERED_BEFORE_DISPATCH: ["runtime", "inspect_record", "原 task 尚未尝试派发；显式恢复只封存未派发失败，不发送 prompt。"],
  NO_PROGRESS: ["timeout", "observe_original", "连续无原 request 执行事件达到本轮时限；已尝试派发时结果未知。继续观察原请求，必要时显式 recover，不自动重发或取消。"],
  REQUEST_FAILED: ["unknown", "inspect_result", "原 journal 有 canonical 失败，但底层类别未知；副作用可能已发生。核对原结果，不因泛化失败换模型、放权或重发。"],
  REQUEST_AUTH_REQUIRED: ["auth", "respect_denial", "ACP 明确要求认证；由负责人核对授权和认证。不要换模型、自动放权或重发；副作用仍须核对。"],
  REQUEST_PERMISSION_DENIED: ["permission", "respect_denial", "ACP 明确拒绝权限或非交互权限请求；尊重拒绝，不自动放权、换模型或重发。"],
  REQUEST_OUTCOME_UNKNOWN: ["unknown", "observe_original", "原请求结果和副作用未知，底层类别未知；只观察原 task/request，必要时显式 recover，不重新派发。"],
  TURN_TRANSPORT_INTERRUPTED: ["transport", "observe_original", "ACP 报告原请求通信中断；不能据此判定业务失败或未派发。观察原 request，不重发。"],
  CANCEL_UNCONFIRMED: ["unknown", "observe_original", "原 request 的取消未确认；取消意图可能已保存或 RPC 已发送。查原 canonical 结果，不做 session-wide cancel。"],
  UNSAFE_OWNER_SOCKET: ["storage", "observe_original", "原 request 的 owner socket 未通过安全校验；保留现场，不绕过身份校验或扩大取消范围。"],
  TASK_TERMINAL: ["input", "inspect_result", "原 task 已有可信终态；读取 result，不再次取消或派发。"],
  INVALID_RECEIPT: ["callback", "recover_original", "202 没有有效 receipt，handoff 未确认；outbox 仍重试原 exact body，进程停止后仅显式 recover。"],
  CALLBACK_RETRYABLE_STATUS: ["callback", "recover_original", "callback 返回可重试状态；沿原 body 和已保存 Retry-After 等待，不重派业务。"],
  DELIVERY_UNCONFIRMED: ["unknown", "recover_original", "callback handoff 未确认，底层类别未知；可能已被接收。仅补投原 exact body，不重新生成注册或业务请求。"],
  REDIRECT_REFUSED: ["callback", "inspect_record", "callback 重定向被拒绝；保留原 outbox，不向新地址发送 bearer。"],
  CALLBACK_REJECTED: ["callback", "inspect_record", "callback 被明确拒绝；保留原 body 和记录，由负责人处理，不重派业务。"],
  TASK_WRITE_FAILED: ["storage", "inspect_record", "记录写入或 fsync 失败；持久结果和副作用可能未知。保留现场，先查原 task，不把失败当作未接受或未派发。"],
  TASK_OPERATION_FAILED: ["unknown", "inspect_record", "任务操作失败，底层类别未知；保留现场，核对原 task，不自动重发。"],
  TASK_MODULE_UNAVAILABLE: ["configuration", "check_installation", "任务模块未能加载；核对安装 inventory，不运行 Provider 或替换 active 来诊断。"],
  TASK_NOT_FOUND: ["storage", "inspect_record", "未找到所列 task 记录；核对 task_id 和存储，不把缺失当作重放授权。"],
  TASK_READ_FAILED: ["storage", "inspect_record", "私有记录读取失败；核对记录及文件系统，缺失输出不证明请求未执行。"],
  INVALID_TASK_ID: ["input", "fix_input", "task_id 须为 task_ 加 64 位小写十六进制摘要。"],
  INVALID_TASK_RESULT: ["storage", "inspect_record", "记录内容损坏或不符合当前契约；保留原字节，不改写、迁移或重放。"],
  INVALID_SESSION_OWNER: ["storage", "inspect_record", "session store 的 owner 不可信；保留原记录，不 adopt 或重派。"],
  UNSAFE_TASK_FILE: ["storage", "inspect_record", "文件未通过类型、属主、私有权限或单链接校验；不要绕过校验。"],
  UNSAFE_TASK_DIRECTORY: ["storage", "inspect_record", "目录或路径未通过私有安全校验；不要绕过校验或接管已有目录。"],
  UNSUPPORTED_TASK_RECORD: ["storage", "inspect_record", "task 不是完整受支持的 v2 记录；保留原字节，不迁移或重放。"],
  UNSUPPORTED_LAUNCH_RECORD: ["storage", "inspect_record", "launch 不是受支持的 v2 记录；保留原字节，不迁移或重放。"],
  UNSUPPORTED_SESSION_RECORD: ["storage", "inspect_record", "session binding 不是受支持的 v2 记录；保留原字节，不 adopt。"],
  TASK_RECORD_TOO_LARGE: ["storage", "inspect_record", "文件超过该入口的读取限额；保留原文件，不裁改记录来通过校验。"],
  TASK_READ_BUDGET: ["storage", "retry_read", "本页读取预算已用尽；沿返回游标继续有界只读查询。"],
  TASK_RECORD_CHANGED: ["storage", "retry_read", "记录在有界读取中变化；可重试只读查询，不重派任务。"],
  INVALID_CURSOR: ["input", "fix_input", "list cursor 无效或筛选不匹配；用相同筛选续页，或从首项重查并按 task_id 去重。"],
  CURSOR_STALE: ["storage", "retry_read", "目录身份已变化；从首项重查并按 task_id 去重。查询不是事务快照。"],
  TASK_DIRECTORY_UNREADABLE: ["storage", "inspect_record", "有界目录查询失败；coverage 不完整，不把空 items 当作空库。"],
  OBSERVATION_TIMEOUT: ["timeout", "observe_original", "本次观察等待超时，不证明原业务终态；观察原请求，不重发。"],
  UNKNOWN_RECORDED_CODE: ["unknown", "inspect_record", "记录中的错误类别无法安全识别；保留原字节，核对原 task/result，不猜根因。"],
};
const stages = new Set(["input", "validate", "selection", "repository", "claimed", "fetch", "branch", "worktree_directory", "worktree", "submit", "control", "setup", "dispatch", "observe", "result", "outbox", "cancel", "read", "list", "runtime", "unknown"]);
const fields = new Set(["arguments", "command", "input_file", "fields", "schema_version", "key", "prompt", "callback", "callback.callback_id", "callback.callback_url", "callback.max_output_bytes", "permissions", "permissions.mode", "permissions.policy", "permissions.policy.autoApprove", "permissions.policy.autoDeny", "permissions.policy.escalate", "permissions.policy.defaultAction", "provider", "model", "variant", "selection", "environment", "model_config", "repo_path", "branch", "base", "worktree", "continue_from", "task_id", "request", "session", "task_store", "task_record", "launch_record", "session_record", "cancel_record", "control_ack", "settings", "installation", "receipt", "cursor", "limit", "scan_limit", "state", "no_progress_timeout_seconds", "unknown"]);
const categories = new Set(Object.values(definitions).map(([category]) => category));
const actions = new Set(Object.values(definitions).map(([, action]) => action));
const reasons = new Set(["unknown", "missing", "invalid", "timeout", "invalid_ack", "process_exit", "process_start_failed", "selection_process_failed", "read_failed", "snapshot_failed", "EACCES", "EPERM", "ENOENT", "ENOSPC", "EDQUOT", "EROFS", "EIO", "EAGAIN", "EMFILE", "ENFILE", "AUTH_REQUIRED", "PERMISSION_DENIED", "PERMISSION_PROMPT_UNAVAILABLE", "ACP_MODEL_UNSUPPORTED", "ACP_SESSION_INIT_FAILED", "ACP_BACKEND_UNAVAILABLE", "ACP_BACKEND_MISSING", "ACP_DISPATCH_DISABLED", "AGENT_SPAWN_ENOENT", "AGENT_STARTUP_FAILED", "AGENT_DISCONNECTED", "QUEUE_RUNTIME_PROMPT_FAILED", "QUEUE_DISCONNECTED_BEFORE_ACK", "QUEUE_DISCONNECTED_BEFORE_COMPLETION", "QUEUE_SUBMISSION_OUTCOME_UNKNOWN", "WATCH_OUTCOME_UNKNOWN", "SESSION_JOURNAL_WRITE_FAILED"]);
const environmentNames = new Set([...["COPILOT", "CODEX"].flatMap((name) => [`${name}_BASE_URL`, `${name}_API_KEY`]), ...["CONTEXT7", "FIRECRAWL", "GITHUB", "GITHUB_ACTIONS"].flatMap((name) => ["ENABLED", "URL", "API_KEY", "AUTH_HEADER", "AUTH_SCHEME"].map((suffix) => `${name}_MCP_${suffix}`))]);
const nativeKinds = new Map([
  ["AUTH_REQUIRED", { category: "auth", terminalCode: "REQUEST_AUTH_REQUIRED" }],
  ...["PERMISSION_DENIED", "PERMISSION_PROMPT_UNAVAILABLE"].map((code) => [code, { category: "permission", terminalCode: "REQUEST_PERMISSION_DENIED" }]),
  ...["AGENT_DISCONNECTED", "QUEUE_DISCONNECTED_BEFORE_ACK", "QUEUE_DISCONNECTED_BEFORE_COMPLETION"].map((code) => [code, { category: "transport", observationCode: "TURN_TRANSPORT_INTERRUPTED" }]),
]);
const allowed = (value, values, fallback) => values.has(value) ? value : fallback;
const handle = (value, task = false) => typeof value === "string" && (task ? /^task_[a-f0-9]{64}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/).test(value) && !value.includes("tcb_") ? value : undefined;

export function errorCode(error, fallback = "TASK_OPERATION_FAILED") {
  const value = error instanceof TaskError ? error.code : typeof error === "string" ? error : error?.message;
  return Object.hasOwn(definitions, value) ? value : fallback;
}
export function errorInfo(error, context = {}) {
  const code = errorCode(error, Object.hasOwn(definitions, context.fallback) ? context.fallback : "TASK_OPERATION_FAILED");
  const source = error instanceof TaskError ? { ...error, ...context } : context;
  const [category, action, hint] = definitions[code];
  return { code, stage: allowed(source.stage, stages, "unknown"), field: allowed(source.field, fields, "unknown"),
    category: allowed(source.category, categories, category), reason: allowed(source.reason, reasons, "unknown"),
    action: allowed(source.action, actions, action), hint,
    ...(handle(source.task_id, true) ? { task_id: source.task_id } : {}),
    ...(handle(source.request_id) ? { request_id: source.request_id } : {}),
    ...(Array.isArray(source.environment_names) ? { environment_names: [...new Set(source.environment_names.filter((name) => environmentNames.has(name)))].sort() } : {}),
    ...(Number.isInteger(source.http_status) && source.http_status >= 100 && source.http_status <= 599 ? { http_status: source.http_status } : {}) };
}
export class TaskError extends Error {
  constructor(code, context) {
    const safe = errorInfo(code, context);
    super(safe.code); this.name = "TaskError";
    Object.assign(this, safe);
    this.stack = `TaskError: ${safe.code}`;
  }
}
export function runtimeError(error, { stage = "observe", field = "request", fallback = "REQUEST_OUTCOME_UNKNOWN", uncertain = false } = {}) {
  if (error instanceof TaskError) return new TaskError(error.code, { field, ...error, stage });
  const native = error?.outputCode ?? error?.code, detail = allowed(error?.detailCode, reasons, undefined);
  const reason = native === -32000 && error?.data?.authRequired === true ? "AUTH_REQUIRED" : detail ?? allowed(native, reasons, "unknown");
  const kind = nativeKinds.get(reason) ?? nativeKinds.get(native) ?? { category: "unknown" };
  return new TaskError((uncertain ? kind.observationCode : kind.terminalCode) ?? fallback, { stage, field, category: kind.category, reason,
    ...(["auth", "permission"].includes(kind.category) ? { action: "respect_denial" } : {}) });
}

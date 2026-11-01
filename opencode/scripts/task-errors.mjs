/** 任务层安全错误。只保留固定分类；不保存底层 message、cause 或 stack。 */
const definitions = {
  INVALID_COMMAND: ["input", "fix_input", "核对 --help 中的公开命令。"],
  INVALID_ARGUMENTS: ["input", "fix_input", "核对 --help 中的参数名称、数量和范围。"],
  INVALID_SUBMIT: ["input", "fix_input", "内部 key/prompt 无效；公开入口为 launch。"],
  INVALID_CWD: ["input", "fix_input", "任务 cwd 须为可访问的绝对目录；不改向其他 checkout。"],
  INVALID_SESSION: ["input", "fix_input", "session 名称不符合绑定契约；公开 launch 不接受手工 session。"],
  INVALID_MODEL_PROFILE: ["configuration", "check_configuration", "profile 须为 env 或 external。"],
  INVALID_RESULT: ["input", "inspect_result", "任务结果状态不符合契约；不伪造成功或重派。"],
  INVALID_LAUNCH_INPUT: ["input", "fix_input", "修正所列字段或字段组合；不要把私密注册内容放入其他字段。"],
  INVALID_LAUNCH_JSON: ["input", "fix_input", "输入文件不是有效 JSON；修正文件编码或 JSON 语法。"],
  LAUNCH_INPUT_UNREADABLE: ["storage", "inspect_record", "核对私有输入文件是否存在、可读且路径安全；尚未进入 Git 准备。"],
  INVALID_CALLBACK: ["input", "fix_input", "核对原生 callback 字段、URL 和限额；勿输出注册。"],
  CALLBACK_IN_PROMPT: ["input", "fix_input", "从业务 prompt 中移除 callback 私密内容；保留原注册。"],
  INVALID_PERMISSIONS: ["input", "fix_input", "核对 permissions 模式和 policy；格式修正不增加授权。"],
  INVALID_NO_PROGRESS_TIMEOUT: ["input", "fix_input", "no_progress_timeout_seconds 须为 1～86400 的整数，省略为 900。"],
  INVALID_MODEL: ["input", "fix_input", "核对 provider/model 选择和完整模型定义；不要自动切换模型。"],
  INVALID_VARIANT: ["input", "fix_input", "核对 variant 是否由所选模型支持；不要改变已绑定 session 的选择。"],
  LAUNCH_SELECTION_INVALID: ["unknown", "check_configuration", "选择或配置解析失败；核对所列字段。"],
  LAUNCH_ENVIRONMENT_INVALID: ["configuration", "check_environment", "修正所列环境变量，勿输出值或回退 Provider。"],
  TASK_MODEL_CONFIG_REQUIRED: ["configuration", "check_configuration", "任务需要完整模型配置；核对 profile。"],
  TASK_TITLE_LOW_UNAVAILABLE: ["configuration", "check_configuration", "完整模型配置须支持 title 的 low variant；不改变主请求路由。"],
  LAUNCH_CONFLICT: ["input", "inspect_record", "同 key 已有不同输入；核对原 launch，不换 key 重派。"],
  SUBMIT_CONFLICT: ["storage", "inspect_record", "task 与提交意图不符；核对原关联，不再次 submit。"],
  LAUNCH_METADATA_REQUIRED: ["storage", "inspect_record", "缺少 launch/task 关联；不 adopt session 或重派。"],
  CONTINUE_BUSY_OR_UNKNOWN: ["unknown", "observe_original", "原请求未终态；用 status/result 观察，不启动第二个写入者。"],
  CONTINUE_NOT_LATEST: ["input", "inspect_record", "续接须使用最新可信轮次；先核对原关联。"],
  CONTINUE_SESSION_UNCONFIRMED: ["unknown", "observe_original", "backend session 未确认；观察原请求，不建立替代 session。"],
  LAUNCH_OBJECT_CONFLICT: ["storage", "inspect_preparation", "Git 对象冲突；人工核对，不覆盖、清理或换名。"],
  GIT_PREPARATION_INTERRUPTED: ["unknown", "inspect_preparation", "用 opencode-task status TASK_ID 读取准备摘要；无完整 task 时 recover 不适用。人工核对 Git 和原输入；同 key 不自动续完，不换 key 重派或自动清理。"],
  GIT_REPOSITORY_INVALID: ["input", "inspect_preparation", "核对 Git 顶层及 origin；不输出 remote/stderr。"],
  GIT_FETCH_FAILED: ["unknown", "inspect_preparation", "fresh fetch 失败；核对 base 和 Git 诊断，不使用缓存。"],
  GIT_PREPARE_FAILED: ["unknown", "inspect_preparation", "Git 准备失败；保留分支、目录和 claim，人工核对。"],
  CONTROL_START_FAILED: ["runtime", "observe_original", "控制进程未启动；先查原 task，必要时显式 recover。"],
  CONTROL_ACK_UNKNOWN: ["unknown", "observe_original", "ACK 未确认，可能已派发；查原 task，不杀进程或重发。"],
  MODEL_OR_SESSION_SETUP_FAILED: ["unknown", "check_configuration", "初始化失败，prompt 未派发；核对保存配置和 session。"],
  SESSION_MODEL_CONFLICT: ["input", "inspect_record", "session 模型/profile/variant 固定，不切换。"],
  SESSION_IDENTITY_CONFLICT: ["unknown", "inspect_record", "backend session 身份缺失或变化；不建立替代 session。"],
  SESSION_MODEL_UNCONFIRMED: ["configuration", "check_configuration", "ACP 未确认 model/effort；不发送 prompt。"],
  UNSUPPORTED_ACPX_RUNTIME: ["configuration", "check_installation", "需要固定 acpx 0.21.1；核对安装。"],
  RECOVERED_BEFORE_DISPATCH: ["runtime", "inspect_record", "原 task 未派发；本次恢复只封存失败。"],
  NO_PROGRESS: ["timeout", "observe_original", "原 request 执行静默达到本轮时限；派发后结果未知，继续观察，不重发或自动取消。"],
  REQUEST_FAILED: ["unknown", "inspect_result", "canonical 失败，根因未知；副作用可能发生。核对原结果。"],
  REQUEST_AUTH_REQUIRED: ["auth", "respect_denial", "ACP 要求认证；负责人核对授权，不绕过拒绝。"],
  REQUEST_PERMISSION_DENIED: ["permission", "respect_denial", "ACP 拒绝权限；不放权、换模型或重发。"],
  REQUEST_OUTCOME_UNKNOWN: ["unknown", "observe_original", "原请求结果和副作用未知；只观察原 request，必要时显式 recover。"],
  TURN_TRANSPORT_INTERRUPTED: ["transport", "observe_original", "ACP 通信中断；观察原 request，不推断业务失败或未派发。"],
  CANCEL_UNCONFIRMED: ["unknown", "observe_original", "取消未确认；查原 canonical 结果，不扩大为 session 取消。"],
  UNSAFE_OWNER_SOCKET: ["storage", "observe_original", "取消 socket 身份未确认；不绕过校验或扩大取消。"],
  TASK_TERMINAL: ["input", "inspect_result", "原 task 已有可信终态；读取 result，不再次取消或派发。"],
  INVALID_RECEIPT: ["callback", "recover_original", "202 无有效 receipt；outbox 只重试原 body。"],
  CALLBACK_RETRYABLE_STATUS: ["callback", "recover_original", "callback 可重试；沿原 body 和 Retry-After 等待。"],
  DELIVERY_UNCONFIRMED: ["unknown", "recover_original", "callback handoff 未确认；可能已接收，只补投原 body。"],
  REDIRECT_REFUSED: ["callback", "inspect_record", "拒绝重定向，不向新地址发送 bearer。"],
  CALLBACK_REJECTED: ["callback", "inspect_record", "callback 被拒绝；保留原 body，由负责人处理。"],
  TASK_WRITE_FAILED: ["storage", "inspect_record", "写入或 fsync 失败；持久性未知。查原 task，不推断未接受或未派发。"],
  TASK_OPERATION_FAILED: ["unknown", "inspect_record", "操作失败，根因未知；核对原 task，不重发。"],
  TASK_MODULE_UNAVAILABLE: ["configuration", "check_installation", "任务模块加载失败；核对安装 inventory。"],
  TASK_NOT_FOUND: ["storage", "inspect_record", "task 记录缺失；核对 task_id，不重放。"],
  TASK_READ_FAILED: ["storage", "inspect_record", "记录读取失败；不推断请求未执行。"],
  INVALID_TASK_ID: ["input", "fix_input", "task_id 须为 task_ 加 64 位小写十六进制摘要。"],
  INVALID_TASK_RESULT: ["storage", "inspect_record", "记录损坏；保留原字节，不迁移或重放。"],
  UNSAFE_TASK_FILE: ["storage", "inspect_record", "文件未通过类型、属主、私有权限或单链接校验；不要绕过校验。"],
  UNSAFE_TASK_DIRECTORY: ["storage", "inspect_record", "目录或路径未通过私有安全校验；不要绕过校验或接管已有目录。"],
  UNSUPPORTED_TASK_RECORD: ["storage", "inspect_record", "tasks-v3 只接受当前 v3 task；不迁移或重放其他格式。"],
  UNSUPPORTED_LAUNCH_RECORD: ["storage", "inspect_record", "tasks-v3 只接受当前 v3 claim；不迁移或重放其他格式。"],
  TASK_RECORD_TOO_LARGE: ["storage", "inspect_record", "文件超过该入口的读取限额；保留原文件，不裁改记录来通过校验。"],
  OBSERVATION_TIMEOUT: ["timeout", "observe_original", "观察等待超时；不证明业务终态，不重发。"],
  UNKNOWN_RECORDED_CODE: ["unknown", "inspect_record", "未知错误类别；核对原 task/result，不猜根因。"],
};
const stages = new Set(["input", "validate", "selection", "repository", "claimed", "fetch", "branch", "worktree_directory", "worktree", "submit", "control", "setup", "dispatch", "observe", "result", "outbox", "cancel", "read", "list", "runtime", "unknown"]);
const fields = new Set(["arguments", "command", "input_file", "fields", "schema_version", "key", "prompt", "callback", "callback.callback_id", "callback.callback_url", "callback.max_output_bytes", "permissions", "permissions.mode", "permissions.policy", "permissions.policy.autoApprove", "permissions.policy.autoDeny", "permissions.policy.escalate", "permissions.policy.defaultAction", "provider", "model", "variant", "selection", "environment", "model_config", "repo_path", "branch", "base", "worktree", "continue_from", "task_id", "request", "session", "task_store", "task_record", "launch_record", "session_record", "cancel_record", "control_ack", "settings", "installation", "receipt", "cursor", "limit", "scan_limit", "state", "no_progress_timeout_seconds", "unknown"]);
const categories = new Set(Object.values(definitions).map(([category]) => category));
const gitReasons = new Set(["SSH_HOST_KEY_VERIFICATION_FAILED", "SSH_OPTIONS_UNSUPPORTED"]);
const gitErrnos = new Set(["ENOENT", "EACCES", "EPERM", "EAGAIN", "ENOMEM", "EMFILE", "ENFILE", "ENOEXEC", "ENOTDIR", "E2BIG", "ETXTBSY", "EIO"]);
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
    category: allowed(source.category, categories, category), reason: gitReasons.has(source.reason) ? source.reason : allowed(source.reason, reasons, "unknown"),
    action: allowed(source.action, actions, action), hint,
    ...(handle(source.task_id, true) ? { task_id: source.task_id } : {}),
    ...(handle(source.request_id) ? { request_id: source.request_id } : {}),
    ...(Array.isArray(source.environment_names) ? { environment_names: [...new Set(source.environment_names.filter((name) => environmentNames.has(name)))].sort() } : {}),
    ...(Number.isInteger(source.http_status) && source.http_status >= 100 && source.http_status <= 599 ? { http_status: source.http_status } : {}),
    ...(gitErrnos.has(source.git_errno) ? { git_errno: source.git_errno } : {}),
    ...(Number.isInteger(source.git_exit_code) && source.git_exit_code >= 0 && source.git_exit_code <= 255 ? { git_exit_code: source.git_exit_code } : {}),
    ...(["SIGHUP", "SIGINT", "SIGQUIT", "SIGKILL", "SIGTERM", "SIGABRT", "SIGSEGV", "SIGPIPE", "SIGBUS", "SIGXCPU", "SIGXFSZ"].includes(source.git_signal) ? { git_signal: source.git_signal } : {}) };
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

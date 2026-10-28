# 同模型、不同端点的第二个 Provider

已核对上游 v2.2.0（`1097e2668b1e08ad63bdf0b1c4860b9bc01e420c`）的
`ConfigProvider.Info`、`ConfigModel.Selection`、`ConfigAgent.Info` 和
`core/src/config/plugin/provider.ts`。`providers` 按 Provider ID 区分端点和凭据，
同名模型可以同时存在。此用法不需要修改 OpenCode 或模块的生产代码。

下文是配置准备方法。实际 Provider ID、URL 和密钥注入位置尚未提供；尚未配置或实测新服务。
请提供非秘密的 Provider ID、URL，以及密钥由哪个现有 secret/env 机制注入。
不要在聊天、Terraform、JSON、命令参数或报告中粘贴密钥。
新端点须兼容当前使用的 **OpenAI Responses** 协议；模型同名不等于协议和访问权已验证。

## 生成外部 JSON

从仓库根目录执行下面的命令。先选定一个新的、仅当前用户可读写的目录。
将 `<PROVIDER_ID>` 换成实际别名，将输出路径换成该目录中的新文件。
若已有 `OPENCODE_MODULE_CONFIG`，把第一个路径换成那个完整 JSON，保留其中的其他设置。
输入必须包含完整的 `providers.copilot`，不能只使用简化的模型名列表。
脚本不读取端点或密钥，也不联系服务；输出文件用 0600 模式独占创建，拒绝覆盖。

```sh
python3 -B - opencode/scripts/profile-env.json '<PROVIDER_ID>' /private/opencode-two-providers.json <<'PY'
import copy
import json
import os
from pathlib import Path
import re
import sys

source, provider_id, destination = sys.argv[1:]
if not re.fullmatch(r'[a-z][a-z0-9_-]*', provider_id):
    raise ValueError('choose a lowercase provider ID')
config = json.loads(Path(source).read_text())
config.setdefault('$schema', 'https://opencode.ai/config.json')
if provider_id in config['providers']:
    raise ValueError('provider ID already exists')
provider = copy.deepcopy(config['providers']['copilot'])
provider['name'] = provider_id
provider['env'] = ['SECOND_LLM_API_KEY']
provider['settings'].update(baseURL='{env:SECOND_LLM_BASE_URL}', apiKey='{env:SECOND_LLM_API_KEY}')
config['providers'][provider_id] = provider
# v2.2.0 原生字段；先保留旧策略顺序，再允许新 Provider。
legacy = config.get('experimental', {}).pop('policies', [])
config['policies'] = [*legacy, *config.get('policies', []),
                      {'action': 'provider.use', 'resource': provider_id, 'effect': 'allow'}]
descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'w') as stream:
    json.dump(config, stream, indent=2)
    stream.write('\n')
PY
```

此命令保留原 copilot、主模型 Sol/max、title Sol/low、compaction buffer=13600 和 MCP 设置。
它完整复制两个模型的 cost、capabilities、limits、settings 和五个 variants，
而不依赖 `canonical`、catalog 的默认模型或跨 Provider 的隐式继承。
两模型仍为 context=400000、input=272000、output=128000。
`experimental.policies` 在 v2.2.0 仍可读取，但已弃用；新示例用顶层 `policies`。
策略先 deny `*`，再 allow copilot 和新 ID。更高优先级的 managed policy 仍可能禁止它。

## 转发环境与选择模型

模块输入 `runtime_env_allowlist` 需要包含：

```hcl
runtime_env_allowlist = [
  "LLM_BASE_URL", "LLM_API_KEY",
  "SECOND_LLM_BASE_URL", "SECOND_LLM_API_KEY",
]
```

这只声明变量名，不设置值。请通过既有 secret/env 注入机制给启动 acpx、OpenCode 或
opencode-task 的进程提供它们。已有 allowlist 应合并保留。
设置 `OPENCODE_MODULE_CONFIG=/private/opencode-two-providers.json` 后，外部 JSON 会覆盖
bundled profile；`LLM_*` 也必须显式允许。`OPENCODE_MODULE_CONFIG` 自身已有转发支持，
acpx → OpenCode 会沿用该路径和获准的变量。文件路径必须能被两个进程读取。
外部配置不会获得 bundled profile 的 LLM/MCP 值校验或自动 MCP 开关处理。
若沿用启用的 MCP，请保留完整 server 配置，并显式允许其 URL、API key 等引用变量；
如果从 bundled JSON 起步，四个 MCP 均保持 disabled。

只添加 Provider 不改变默认选择。要让后续新任务使用新端点，编辑**新外部文件**：

```json
{
  "model": { "providerID": "<PROVIDER_ID>", "model": "gpt-6.1-sol", "variant": "max" },
  "agents": {
    "title": { "model": { "providerID": "<PROVIDER_ID>", "model": "gpt-6.1-sol", "variant": "low" } }
  }
}
```

此片段仅表示要改的字段，不是完整替代配置。两处也可独立选择 copilot 或新 Provider。
切换 Astra 时沿用完整模型定义并显式选择 variant；现有默认仍是 Sol/max。
模块从顶层 `model` 自动设置 readiness 的显式 `provider/model` 和 variant；
无需另设 `OPENCODE_ACP_REQUIRED_*` 来覆盖它。title 单独选 low，不会把主模型改成 low。
已有 session 的已选模型不会因为修改默认值而自动切换。

可运行 `opencode --module-profile-info` 确认 source 为 external。
该命令只报告来源，不证明模型可访问。实际接入仍需用户提供上述非秘密信息，
另行授权配置注入和端点验证；本次只进行隔离占位配置、schema 与 loopback 验证。

参考：[V2 providers](https://opencode.ai/v2/docs/providers)、
[V2 policies](https://opencode.ai/v2/docs/policies)。精确行为以上述固定提交为准。

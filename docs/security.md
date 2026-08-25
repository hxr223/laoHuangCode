# 安全模型

laoHuangCode 不是完整沙箱。当前版本不提供工具执行确认，模型请求的
工具调用会直接执行。

## 默认行为

文件工具由 `@laohuang/tool-fs` 提供，Bash 执行由 `@laohuang/tool-bash` 通过
`@laohuang/bash-local` 提供；这些 package 边界不构成安全沙箱。

| 工具 | 默认行为 | 原因 |
| --- | --- | --- |
| `read` | 直接执行 | 仅允许读取项目根目录内的 UTF-8 文件 |
| `write` | 直接执行 | 会创建或完整覆盖文件 |
| `edit` | 直接执行 | 会修改现有文件 |
| `bash` | 直接执行 | 可执行任意 Bash 命令 |

## 已有防护

- `read`、`write`、`edit` 将解析后的路径限制在启动目录内。
- 文件工具阻止 `..` 和符号链接越过项目根目录。
- `edit` 只接受恰好出现一次的旧文本，避免模糊批量替换。
- 同一解析路径上的 `write`、`edit` 使用文件修改锁串行执行，避免并发丢失更新；不同文件仍可并发。
- 工具日志隐藏 `content`、`old_text`、`new_text` 的正文以及 `edits` 替换列表。
- API key 在终端隐藏输入（不回显），不接受命令行参数，也不进入 Shell 历史。
- API key 保存在独立的 `credentials.json`，文件权限为 `0600`；程序创建的默认父目录为 `0700`。
- API key 只通过注入 resolver 传给 `@laohuang/llm-pi-ai`，不写入环境变量或 Agent 消息。
- `llm-pi-ai` receives API keys through an injected resolver and does not read or write credential files.
- Model errors and DSML protocol-leak diagnostics never include API keys, authorization headers, complete prompts, complete model output, or raw tool results.
- Textual DSML is treated as untrusted assistant text and is never dispatched to Tool Runtime.

## 明确不保证的边界

- Bash 以当前用户权限运行，没有文件系统、网络、进程或系统调用沙箱。
- 同一批工具默认并发执行；`bash` 可能与文件工具或其他 Bash 命令产生无法自动识别的副作用竞争。
- Bash 可以读取其他环境变量和用户可访问的文件。
- `credentials.json` 是权限受限的明文文件，不是操作系统 Keychain。
- 项目内文件可能包含提示注入内容，诱导模型请求危险工具。
- 工具执行前不会暂停并请求用户确认。
- 目前没有命令 allowlist、Git 回滚、资源配额或审计持久化。

因此应在版本控制下的可信项目中运行，提交或暂存重要改动，并避免在包含生产密钥的
宿主环境中使用。

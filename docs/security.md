# 安全模型

laoHuangCode 不是完整沙箱。当前版本不提供工具执行确认，模型请求的
工具调用会直接执行。

## 默认行为

文件工具由 `@laohuang/tool-fs` 提供，Bash 执行由 `@laohuang/tool-bash` 通过
`@laohuang/bash-local` 提供；这些 package 边界不构成安全沙箱。

| 工具 | 默认行为 | 原因 |
| --- | --- | --- |
| `read` | 直接执行 | 可读取当前用户有权访问的 UTF-8 文件 |
| `write` | 直接执行 | 会创建或完整覆盖文件 |
| `edit` | 直接执行 | 会修改现有文件 |
| `bash` | 直接执行 | 可执行任意 Bash 命令 |

## 已有防护

- `edit` 只接受恰好出现一次的旧文本，避免模糊批量替换。
- 同一解析路径上的 `write`、`edit` 使用文件修改锁串行执行，避免并发丢失更新；不同文件仍可并发。
- 工具日志隐藏 `content`、`old_text`、`new_text` 的正文以及 `edits` 替换列表。
- API key 在终端隐藏输入（不回显），不接受命令行参数，也不进入 Shell 历史。
- API key 和供应商 setup 字段保存在独立的 version 2 `credentials.json`，文件权限为 `0600`；程序创建的默认父目录为 `0700`。
- `config.json` 保存 profile、provider、model、base URL 和可选的 Bash 路径 `shell_path`，不包含 runtime credential。
- `@laohuang/llm-pi-ai` 通过 neutral credential bridge 读取 API-key credential；只有该包导入 pi-ai。
- OAuth login、device code、callback server、access/refresh token storage 和 OAuth refresh 明确不实现。
- `amazon-bedrock`、`google-vertex` 和 OAuth-only providers 不暴露为 available provider；直接 Google API provider `google` 单独存在。
- Model errors and DSML protocol-leak diagnostics never include API keys, authorization headers, complete prompts, complete model output, or raw tool results.
- Textual DSML is treated as untrusted assistant text and is never dispatched to Tool Runtime.
- Model Runtime 拥有 retry：默认最多 3 次，延迟 250ms、1000ms；authentication、context-overflow、protocol、cancel、stale request 和 post-delta failure 不重试。

## 明确不保证的边界

- Bash 以当前用户权限运行，没有文件系统、网络、进程或系统调用沙箱。
- `read`、`write`、`edit` 接受绝对路径；相对路径以启动目录为基准，并允许通过 `..` 或符号链接访问启动目录外当前用户有权访问的文件。
- Bash 的 `workdir` 接受绝对路径，也允许相对路径解析到启动目录外。
- Windows Shell 路径转换只用于结构化路径参数；`cygpath.exe` 通过独立 argv 调用，
  不拼接 Shell 命令。路径转换不增加访问控制；UNC 路径可能访问网络共享。
- Windows 原生终端通过 Koffi 调用控制台 API；其预编译 optional dependencies 是
  安装信任边界的一部分。POSIX 的 `0600`/`0700` 不是 Windows ACL 安全保证。
- 进程取消属于尽力清理：Unix 进程组信号和 Windows `taskkill /T` 都不是操作系统级
  进程隔离。主动脱离进程组、Shell 退出后的后代进程或权限限制可能导致进程残留；
  输出管道收尾不代表后代进程已被终止。检测到清理失败时工具结果会明确报告。
- 同一批工具默认并发执行；`bash` 可能与文件工具或其他 Bash 命令产生无法自动识别的副作用竞争。
- Bash 可以读取其他环境变量和用户可访问的文件。
- `credentials.json` 是权限受限的明文文件，不是操作系统 Keychain。
- `verified` 只表示显式授权的真实 provider E2E 证据；available/configured 不等于 provider 契约已验证。
- 通用 provider E2E 是联网/付费测试，普通 `npm test` 会跳过。
- 项目内文件可能包含提示注入内容，诱导模型请求危险工具。
- 工具执行前不会暂停并请求用户确认。
- 目前没有命令 allowlist、Git 回滚、资源配额或审计持久化。

因此应在版本控制下的可信项目中运行，提交或暂存重要改动，并避免在包含生产密钥的
宿主环境中使用。

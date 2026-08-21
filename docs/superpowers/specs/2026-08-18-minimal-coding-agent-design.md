# laoHuangCode 最小 Coding Agent 设计

## 1. 背景与目标

`laoHuangCode` 是一个以学习和验证为主的 coding agent 项目。第一阶段不使用 agent 框架，只使用 Python、官方 `openai` SDK 和 OpenAI 兼容的 Chat Completions API，完整呈现模型请求、工具调用和消息循环。

本阶段交付一个可在终端持续对话的最小原型。它能够查看和修改启动目录内的代码，并在该目录中执行 Bash 命令，从而完成“理解任务、查看项目、修改文件、运行验证、回复用户”的基本闭环。

## 2. 范围

### 包含

- 基于终端的交互式 REPL。
- OpenAI 兼容 API 配置。
- Chat Completions 原生 tool calling。
- `read`、`write`、`edit`、`bash` 四个工具。
- 当前进程内的多轮消息历史。
- 工具执行过程的终端展示。
- 防止文件工具访问项目根目录之外的路径。
- Agent 最大工具轮数和 Bash 超时。
- 使用 Python 内置 `unittest` 的单元测试。

### 不包含

- 流式输出。
- 多 agent、子 agent 或任务规划系统。
- 并行工具执行。
- 会话持久化、上下文压缩或记忆系统。
- 审批流程和权限策略引擎。
- 真正的操作系统沙箱或容器隔离。
- Web UI、IDE 集成和远程服务。
- Agent 框架或 `python-dotenv`。

## 3. 技术选择

模型调用采用官方 `openai` Python SDK 的 `client.chat.completions.create()`。配置允许提供自定义 `base_url`，以支持实现 Chat Completions 和原生工具调用协议的 OpenAI 兼容服务。

不采用 Responses API，因为兼容服务对它的支持范围通常小于 Chat Completions。不采用由提示词约定的 JSON 工具协议，因为原生 tool calling 能减少格式解析和纠错代码，更适合第一版原型。

除运行时依赖 `openai` 外，尽量使用 Python 标准库。测试使用 `unittest`。

## 4. 项目结构

```text
laoHuangCode/
├── pyproject.toml
├── README.md
├── .env.example
├── src/laohuangcode/
│   ├── __init__.py
│   ├── __main__.py
│   ├── config.py
│   ├── agent.py
│   └── tools.py
└── tests/
    ├── test_agent.py
    └── test_tools.py
```

各模块职责如下：

- `__main__.py`：创建配置、OpenAI client 和 agent，运行终端 REPL，处理退出与中断。
- `config.py`：读取并校验环境变量，不负责网络请求。
- `agent.py`：维护消息历史，调用模型，解释工具调用，驱动 agent loop。
- `tools.py`：声明四个工具的 JSON Schema，校验参数并执行工具。
- `test_agent.py`：使用假的 client 验证 agent loop，不访问真实模型服务。
- `test_tools.py`：在临时目录中验证工具行为和路径安全。

## 5. 配置

原型使用以下环境变量：

- `OPENAI_API_KEY`：必填。
- `OPENAI_MODEL`：必填。
- `OPENAI_BASE_URL`：选填；未设置时使用 SDK 默认地址。

`.env.example` 只展示变量名和示例，不包含真实密钥。程序不自动解析 `.env` 文件。配置缺失时，程序在发起 API 请求前给出明确提示并退出。

## 6. Agent Loop

程序启动后创建 system message，并进入 REPL。每条用户输入的处理流程为：

1. 将输入作为 `user` 消息追加到当前会话历史。
2. 将完整历史和四个工具定义发送给 Chat Completions API。
3. 如果模型返回普通 assistant 文本，追加并展示该文本，本轮结束。
4. 如果模型返回 `tool_calls`，先把包含工具调用的 assistant 消息追加到历史。
5. 按返回顺序逐个执行工具，展示调用摘要和结果，并把每个结果作为对应 `tool_call_id` 的 `tool` 消息追加到历史。
6. 再次调用模型，直到得到普通 assistant 文本或达到轮数上限。

单个用户任务不限制包含工具调用的模型响应轮数。运行时通过 Token、耗时和连续重复调用保护避免失控，不丢弃已经形成的会话历史。第一版不并行执行多个工具调用。

## 7. 工具契约

### `read(path)`

读取项目根目录内的 UTF-8 文本文件并返回内容。文件不存在、无法解码或路径越界时返回错误结果。

### `write(path, content)`

创建或完整覆盖项目根目录内的 UTF-8 文本文件。必要时创建父目录。写入前执行路径边界校验。

### `edit(path, old_text, new_text)`

读取 UTF-8 文本文件，将 `old_text` 精确替换为 `new_text`。只有当 `old_text` 恰好出现一次时才写回；出现零次或多次都返回错误且不修改文件。

### `bash(command)`

使用 `/bin/bash -lc` 执行命令，以项目根目录作为当前工作目录，捕获 stdout、stderr 和退出码。命令设定固定超时；超时后终止并返回错误。

`bash` 是自动执行的，并不限制命令访问项目外的文件、网络或其他系统资源。README 必须明确说明：路径限制只适用于三个文件工具，`bash` 没有系统级沙箱，不应在不可信环境中运行。

## 8. 路径安全与输出限制

项目根目录在进程启动时固定。文件工具将用户路径解析为真实绝对路径，并确认目标位于根目录本身或其后代中。校验需要覆盖 `..` 路径穿越和符号链接逃逸。

对于尚不存在的写入目标，先解析最近存在的父目录，再结合目标相对路径进行边界判断，避免通过符号链接父目录写出根目录。

工具返回模型的文本设置统一长度上限。超出部分截断并附加明确标记，避免大型文件或命令输出一次占满上下文。终端展示使用相同的安全摘要，不输出 API key。

## 9. 错误处理与终端行为

- API 请求异常：显示错误并结束当前用户轮次，REPL 继续运行。
- 工具异常：转换为文本形式的结构化失败结果返回模型，使模型可以修正参数或换用其他操作。
- 非法工具名或参数：返回工具错误，不使进程崩溃。
- `Ctrl+C`：中断当前操作并返回输入提示符。
- `Ctrl+D` 或 `/exit`：正常结束进程。
- 模型返回空响应或无法识别的响应形态：报告协议错误并结束当前轮次。

工具结果至少包含成功状态；`bash` 结果还包含退出码、stdout 和 stderr。错误信息应对用户和模型可操作，但不包含密钥等敏感配置。

## 10. 测试策略

工具测试在 `tempfile.TemporaryDirectory` 中运行，覆盖：

- `read`、`write`、`edit` 和 `bash` 的正常行为。
- 不存在文件、无效参数、替换零次和替换多次。
- `..` 路径穿越与符号链接逃逸。
- Bash 非零退出码和超时。
- 超长工具输出的截断。

Agent 测试注入假的 OpenAI client，覆盖：

- 模型直接返回最终文本。
- 模型请求工具、程序返回工具结果、模型再返回最终文本的完整循环。
- 单次响应包含多个工具调用时按顺序执行。
- 工具失败仍作为 `tool` 消息交还模型。
- API 异常和最大工具轮数限制。
- 多条 REPL 输入共享进程内消息历史。

真实 API 调用不进入自动化测试，避免网络、费用和密钥依赖。

## 11. 成功标准

完成后，使用者能够：

1. 安装项目并通过三个环境变量连接任一兼容服务。
2. 使用 `python -m laohuangcode` 启动交互式终端。
3. 要求 agent 读取、创建和精确修改项目内文件。
4. 要求 agent 执行命令并依据输出继续工作。
5. 观察到模型与工具之间的完整循环。
6. 使用一个命令运行全部离线测试。

只要以上闭环可靠运行，第一版即完成；额外能力留给后续迭代。

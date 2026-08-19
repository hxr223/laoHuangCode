# 项目架构

`laoHuangCode` 刻意保持一个 Python Agent 内核。Python 包可直接提供 `laohuang`
命令；npm 包只解决全局安装与启动体验，不复制业务逻辑。

## 项目目录

```text
laoHuangCode/
├── .github/workflows/
│   ├── ci.yml                 # Python / Node 持续集成
│   └── release.yml            # PyPI -> npm 顺序发布
├── docs/
│   ├── architecture.md
│   ├── configuration.md
│   ├── npm-distribution.md
│   ├── publishing.md
│   └── security.md
├── npm/
│   ├── bin/laohuang.js        # 全局命令入口
│   ├── lib/launcher.js        # Python 探测、缓存 venv、参数转发
│   ├── test/launcher.test.js
│   └── package.json
├── scripts/
│   ├── build-python.sh
│   ├── check_versions.py
│   ├── release-check.sh
│   └── test-install.sh
├── src/laohuangcode/
│   ├── __main__.py            # python -m 入口
│   ├── agent.py               # Agent loop
│   ├── cli.py                 # CLI、子命令、REPL
│   ├── client.py              # OpenAI SDK 客户端工厂
│   ├── commands.py            # /model、/login、/logout、/help
│   ├── config.py              # Profile 存储与解析
│   ├── credentials.py         # 私有凭据文件
│   ├── model_selection.py     # 供应商与模型交互选择、首次启动凭据引导
│   ├── permissions.py         # 工具权限闸门
│   ├── providers.py           # DeepSeek/OpenAI 预设
│   ├── terminal_ui.py         # Rich 输出与 prompt_toolkit 交互输入
│   ├── tools.py               # read/write/edit/bash
│   └── web.py                 # 本地运行事件面板
├── tests/                     # Python 离线测试
├── LICENSE
├── README.md
└── pyproject.toml
```

## 模块关系

```mermaid
flowchart LR
    User([用户]) --> Entry["laohuang 命令"]
    Entry -->|PyPI 安装| CLI["cli.py"]
    Entry -->|npm 安装| Launcher["Node launcher"]
    Launcher -->|python -m laohuangcode| CLI

    subgraph Core["Python Agent 内核"]
        CLI --> TUI["terminal_ui.py"]
        CLI --> Profiles["config.py + providers.py"]
        CLI --> Secrets["credentials.py"]
        CLI --> Commands["commands.py + model_selection.py"]
        Profiles --> Client["client.py"]
        Secrets --> Client
        Commands --> Client
        CLI --> Agent["agent.py"]
        Commands -->|switch_model| Agent
        CLI --> Gate["permissions.py"]
        CLI --> Registry["tools.py"]
        Agent --> Gate
        Agent --> Registry
        Agent -.运行事件.-> Web["web.py"]
    end

    TUI -->|Markdown / 工具卡片 / 权限确认| User
    Client --> SDK["OpenAI SDK / Chat Completions"]
    Agent --> SDK
    Registry --> Tools["read / write / edit / bash"]
    Browser([本机浏览器]) --> Web
```

## 一次请求的调用流程

```mermaid
sequenceDiagram
    actor User as 用户
    participant CLI as CLI / REPL
    participant Agent as CodingAgent
    participant API as Chat Completions
    participant Gate as PermissionGate
    participant Tools as ToolRegistry

    User->>CLI: 输入编码任务
    CLI->>Agent: run(user_input)
    Agent->>API: messages + tools

    loop 模型返回 tool_calls（最多 20 轮）
        API-->>Agent: tool_calls
        loop 按源顺序预检每个调用
            Agent->>Gate: authorize(name, arguments)
            alt 用户拒绝
                Gate-->>Agent: deny
                Agent->>Agent: 生成拒绝结果
            else read / 已确认 / 会话放行
                Gate-->>Agent: allow
            end
        end
        par 允许的调用默认并发执行
            Agent->>Tools: execute(call 1)
            Tools-->>Agent: result 1
        and
            Agent->>Tools: execute(call N)
            Tools-->>Agent: result N
        end
        Agent->>Agent: 按源顺序组装 tool messages
        Agent->>API: messages + tool results
    end

    API-->>Agent: 普通模型回复
    Agent-->>CLI: 最终文本
    CLI-->>User: 显示回复
```

即使用户拒绝工具，Agent 也会向模型追加对应的 `tool` 角色结果，保持每个
`tool_call_id` 都有配对响应，再让模型解释或选择其他方案。

## 工具并发与顺序

Agent 默认采用与 Pi 相同的批次语义：参数解析和权限确认按模型给出的顺序完成，
通过预检的工具随后在线程池中并发执行。`tool_result` 事件按实际完成顺序立即发出，
但加入会话历史并回传模型的 `tool` 消息始终保持原始 `tool_calls` 顺序，因此日志可
实时反映快慢，模型上下文仍然确定。

`CodingAgent(tool_execution="sequential")` 可以把所有批次切换为串行。
`ToolRegistry(execution_modes={"tool_name": "sequential"})` 可以声明单工具覆盖；
只要一个批次包含串行工具，整个批次都会串行执行。

`write` 和 `edit` 使用解析后绝对路径作为修改锁的键：同一文件的修改逐个完成，避免
丢失更新；不同文件仍可并发。`read` 和 `bash` 不进入文件修改锁，其中 `bash` 可能
修改任意未知文件，因此它与其他工具并发时的副作用仍由权限确认和用户环境承担。

## Web 可观测事件

启用 `--web` 后，`CodingAgent` 旁路发送：

- `user_message`、`model_request`、`model_response`。
- `tool_start`、`tool_approved`、`tool_denied`、`tool_result`。
- `assistant_response`、`model_error`、`agent_error`。
- `model_switched`：供应商或模型切换成功。

事件中的 `turn` 标识用户轮次，`round` 标识一次用户轮次内的模型请求轮次，
`batch_size` 和 `index` 标识同一次响应里的工具批次。浏览器每 500ms 从
`/api/events?after=<id>` 拉取增量事件。日志仅在内存中，CLI 退出时 Web 服务一并
停止。

> 权限确认不是沙箱。尤其是 `bash`，获准后仍拥有当前用户在操作系统中的权限。

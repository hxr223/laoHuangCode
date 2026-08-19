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
│   ├── config.py              # Profile 存储与解析
│   ├── credentials.py         # Provider 凭据解析
│   ├── permissions.py         # 工具权限闸门
│   ├── providers.py           # DeepSeek/OpenAI/custom 预设
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
        CLI --> Profiles["config.py + providers.py"]
        Profiles --> Client["client.py"]
        CLI --> Agent["agent.py"]
        CLI --> Gate["permissions.py"]
        CLI --> Registry["tools.py"]
        Agent --> Gate
        Agent --> Registry
        Agent -.运行事件.-> Web["web.py"]
    end

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
        loop 按顺序执行每个调用
            Agent->>Gate: authorize(name, arguments)
            alt read / 已确认 / 会话放行
                Gate-->>Agent: allow
                Agent->>Tools: execute(name, arguments)
                Tools-->>Agent: 结构化结果
            else 用户拒绝
                Gate-->>Agent: deny
                Agent->>Agent: 生成拒绝结果
            end
        end
        Agent->>API: messages + tool results
    end

    API-->>Agent: 普通模型回复
    Agent-->>CLI: 最终文本
    CLI-->>User: 显示回复
```

即使用户拒绝工具，Agent 也会向模型追加对应的 `tool` 角色结果，保持每个
`tool_call_id` 都有配对响应，再让模型解释或选择其他方案。

## Web 可观测事件

启用 `--web` 后，`CodingAgent` 旁路发送：

- `user_message`、`model_request`、`model_response`。
- `tool_start`、`tool_approved`、`tool_denied`、`tool_result`。
- `assistant_response`、`model_error`、`agent_error`。

事件中的 `turn` 标识用户轮次，`round` 标识一次用户轮次内的模型请求轮次，
`batch_size` 和 `index` 标识同一次响应里的工具批次。浏览器每 500ms 从
`/api/events?after=<id>` 拉取增量事件。日志仅在内存中，CLI 退出时 Web 服务一并
停止。

> 权限确认不是沙箱。尤其是 `bash`，获准后仍拥有当前用户在操作系统中的权限。

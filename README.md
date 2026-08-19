# laoHuangCode

一个用于学习和验证的最小 coding agent。它不依赖 agent 框架，只用 Python、官方 `openai` SDK 和 Chat Completions 原生工具调用实现完整 agent loop。

第一版提供四个工具：

- `read`：读取项目内的 UTF-8 文本文件。
- `write`：创建或完整覆盖项目内文件。
- `edit`：对文件做唯一、精确的文本替换。
- `bash`：在项目根目录执行 Bash 命令。

## 安装

需要 Python 3.11 或更高版本。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

## 配置

程序直接读取环境变量，不会自动加载 `.env`：

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="your-model-name"
export OPENAI_BASE_URL="https://your-compatible-service.example/v1"
```

`OPENAI_BASE_URL` 可省略，此时使用 `openai` SDK 的默认地址。所选服务和模型必须支持 Chat Completions 的原生 tool calling。

## 运行

进入希望 agent 操作的项目目录后运行：

```bash
python -m laohuangcode
```

也可以使用安装生成的命令：

```bash
laohuangcode
```

在终端中持续输入任务，使用 `/exit` 或 `Ctrl+D` 退出。会话历史只保留在当前进程内。

### Web 日志面板

使用 `--web` 在保留终端交互的同时启动本地观察面板：

```bash
python -m laohuangcode --web
```

然后访问终端显示的地址，默认是 <http://127.0.0.1:8765>。修改端口：

```bash
python -m laohuangcode --web --web-port 9000
```

页面按时间展示用户输入、每次模型请求与响应、该响应包含的 `tool_calls` 数量、每个工具的调用序号和结果，以及最终回复。`turn` 区分用户对话轮次，借助同一 `turn` 内的 `round` 和 `batch_size` 可以区分“一次模型响应批量返回多个工具”和“多轮 ReAct 分别调用工具”。

面板仅监听 `127.0.0.1`，日志只保存在当前进程内，退出后清空。`write`、`edit` 的正文不会写入观察日志，长结果会被截断。

## 测试

```bash
python -m unittest discover -s tests -v
```

全部测试都是离线测试，不会请求真实模型 API。

## 安全说明

这是学习原型，不应直接用于不可信环境。

`read`、`write` 和 `edit` 会限制路径位于启动目录内，并阻止 `..` 和符号链接逃逸。Bash 子进程不会继承 `OPENAI_API_KEY`，避免模型通过环境变量读取模型密钥。

但 `bash` 仍会自动执行模型提供的命令，**没有操作系统级沙箱**，能够访问启动目录之外的文件、网络和其他系统资源。运行前应确认当前机器和目录适合执行模型生成的命令。

## 核心流程

```text
用户输入
  -> Chat Completions
  -> 模型返回 tool_calls
  -> 本地执行 read/write/edit/bash
  -> 工具结果发回模型
  -> 模型返回最终回复
```

架构图见 [`docs/architecture.md`](docs/architecture.md)，初始设计见 [`docs/superpowers/specs/2026-08-18-minimal-coding-agent-design.md`](docs/superpowers/specs/2026-08-18-minimal-coding-agent-design.md)。

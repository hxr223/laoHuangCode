# laoHuangCode

一个用于学习和验证的最小 coding agent。核心只使用 Python、官方
`openai` SDK 和 Chat Completions 原生工具调用，不依赖 Agent 框架。

当前提供四个工具：`read`、`write`、`edit`、`bash`。`read` 自动放行；会改变
系统状态的三个工具默认在终端中逐次确认。

同一次模型响应中的多个工具调用默认并发执行。权限检查仍按调用顺序完成，实时事件
按工具实际完成顺序发出，回传模型的 `tool` 消息保持原始调用顺序。同一文件上的
`write` 和 `edit` 会自动排队，不同文件仍可并发处理。

## 快速开始

需要 Node.js 18+ 和 Python 3.11+。面向普通用户的安装方式：

```bash
npm install --global laohuang
laohuang
```

首次启动会在终端中依次选择 DeepSeek 或 OpenAI、隐藏输入 API key、选择模型，
不需要设置环境变量。配置完成后，进入任意项目目录直接运行 `laohuang`。

npm 包只是一个很薄的启动器：第一次运行时，它会在用户缓存目录创建隔离的
Python 环境，并安装版本完全一致的 `laohuangcode` Python 内核。Agent 本身没有
Node.js 重复实现。

开发仓库也可以直接安装：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
laohuang --version
```

## 模型配置

首次运行时，终端会提供两个供应商：

- DeepSeek：内置 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
- OpenAI：使用输入的 API key 动态读取账户可用模型，也可手动输入模型名。

API key 使用隐藏输入，保存在独立的
`~/.config/laohuang/credentials.json` 中。普通模型配置保存在同目录的
`config.json`；两个文件均使用 `0600` 权限，目录使用 `0700` 权限。

```text
/model                              交互选择供应商和模型
/model current                      查看当前模型
/model deepseek deepseek-v4-pro     直接切换模型
/model openai <model-name>          直接切换 OpenAI 模型
/login                              交互选择供应商并登录
/login deepseek                     输入或覆盖 DeepSeek API key
/logout openai                      删除保存的 OpenAI 凭据
```

认证和模型选择相互独立：`/login`、`/logout` 管理凭据，`/model` 只切换模型。
如果请求返回 401，Agent 会提示对应的 `/login <provider>` 命令。旧的
`/apikey set`、`/apikey remove` 暂时保留为兼容别名。

常用配置命令：

```bash
laohuang config list
laohuang config use default
laohuang doctor
```

完整规则见 [模型配置文档](docs/configuration.md)。

## 运行

进入希望 Agent 操作的项目目录后执行：

```bash
laohuang
```

输入任务，使用 `/help` 查看命令，使用 `/exit` 或 `Ctrl+D` 退出。通过 `/model`
切换供应商或模型时会保留当前对话上下文。

交互终端使用 `❯` 作为输入提示符，并支持多行编辑和当前会话的输入历史：

- `Enter`：发送任务。
- `Alt+Enter`：插入换行。
- `↑` / `↓`：浏览历史输入。
- `Ctrl+D`：退出。

模型回复会按 Markdown 渲染；思考过程显示状态动画，工具调用显示为紧凑结果卡片，
完整的逐轮事件仍可通过 Web 日志面板查看。输出被重定向或由程序调用 CLI 时，会自动
回退到稳定的纯文本格式。

`write`、`edit`、`bash` 执行前会显示参数摘要：输入 `y` 仅允许本次，输入 `a`
允许本会话之后的全部操作，其他输入拒绝。仅在你完全信任模型和环境时使用：

```bash
laohuang --dangerously-skip-permissions
```

### Web 日志面板

```bash
laohuang --web
laohuang --web --web-port 9000
```

面板默认位于 <http://127.0.0.1:8765>，展示模型轮次、工具调用、权限结果和最终
回复。它只监听本机，数据只存在内存中，进程退出后清空。

## 开发与发布检查

```bash
python -m unittest discover -s tests -v
npm --prefix npm test
scripts/release-check.sh
```

`release-check.sh` 会检查 Python/npm 版本一致性、运行两套测试、检查 npm 包内容、
构建 Python 分发包并在临时环境验证两个入口。发布设计见
[npm 分发说明](docs/npm-distribution.md) 和 [发布流程](docs/publishing.md)。

## 安全边界

文件工具会限制在启动目录内并阻止符号链接逃逸；API key 不通过环境变量传递给
Bash。但 `bash` **没有操作系统级沙箱**，获准后仍能访问项目外文件、网络和其他
系统资源。公开使用前请阅读 [安全模型](docs/security.md)。

架构图见 [docs/architecture.md](docs/architecture.md)，初始设计见
[最小 Agent 设计](docs/superpowers/specs/2026-08-18-minimal-coding-agent-design.md)。

## License

MIT

# laoHuangCode

一个用于学习和验证的最小 coding agent。核心只使用 Python、官方
`openai` SDK 和 Chat Completions 原生工具调用，不依赖 Agent 框架。

当前提供四个工具：`read`、`write`、`edit`、`bash`。`read` 自动放行；会改变
系统状态的三个工具默认在终端中逐次确认。

## 快速开始

需要 Node.js 18+ 和 Python 3.11+。面向普通用户的安装方式：

```bash
npm install --global laohuang
export DEEPSEEK_API_KEY="your-api-key"
laohuang config --provider deepseek
cd /path/to/your/project
laohuang
```

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

DeepSeek 是当前开箱即用的默认预设：

```bash
export DEEPSEEK_API_KEY="your-api-key"
laohuang config --provider deepseek
```

该预设使用 `https://api.deepseek.com` 和 `deepseek-v4-flash`。也可以配置任意
OpenAI Chat Completions 兼容服务：

```bash
export OPENAI_API_KEY="your-api-key"
laohuang config \
  --profile local \
  --provider custom \
  --model your-model-name \
  --base-url http://127.0.0.1:8000/v1
```

常用配置命令：

```bash
laohuang config list
laohuang config use local
laohuang doctor
laohuang --profile local --model temporary-override
```

配置保存在 `~/.config/laohuang/config.json`，只保存服务地址和模型名，不保存
API key。完整规则见 [模型配置文档](docs/configuration.md)。旧版
`OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_BASE_URL` 环境变量仍可在没有配置文件时
直接使用。

## 运行

进入希望 Agent 操作的项目目录后执行：

```bash
laohuang
```

输入任务，使用 `/exit` 或 `Ctrl+D` 退出。会话历史只保留在当前进程中。

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

文件工具会限制在启动目录内并阻止符号链接逃逸；Bash 子进程不会继承已知的模型
API key。但 `bash` **没有操作系统级沙箱**，获准后仍能访问项目外文件、网络和其他
系统资源。公开使用前请阅读 [安全模型](docs/security.md)。

架构图见 [docs/architecture.md](docs/architecture.md)，初始设计见
[最小 Agent 设计](docs/superpowers/specs/2026-08-18-minimal-coding-agent-design.md)。

## License

MIT

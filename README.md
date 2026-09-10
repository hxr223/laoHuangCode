# laoHuangCode

运行在终端里的开源 AI 编程助手。

[![npm](https://img.shields.io/npm/v/laohuang)](https://www.npmjs.com/package/laohuang)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

用自然语言描述任务，让 Agent 阅读代码、修改文件和执行命令。

## 安装

推荐使用独立安装器，无需预装 Node.js 或 npm。支持 macOS、Linux glibc、Windows
的 x64 / ARM64；需要 Bash，Windows 请先安装 Git for Windows。

macOS / Linux：

```bash
curl -fsSL https://github.com/hxr223/laoHuangCode/releases/latest/download/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://github.com/hxr223/laoHuangCode/releases/latest/download/install.ps1 | iex
```

安装器会校验下载、验证启动，并自动配置用户 `PATH`。安装后打开新终端，
或执行安装器显示的环境刷新命令，即可运行 `laohuang`。
安装路径、指定版本、升级恢复及卸载见 [安装说明](INSTALLING.md)。

也可以通过 npm 全局安装，需要 Node.js >=22.19.0、Bash，并确保 npm 全局命令目录
已经在 `PATH` 中：

```bash
npm install -g laohuang
```

进入项目目录，启动交互会话：

```bash
cd your-project
laohuang
```

首次启动会引导你选择供应商、隐藏输入 API key 并选择模型，无需手动设置环境变量。

更新当前安装：

```bash
laohuang update
```

独立安装会下载 GitHub Releases 的最新安装包，校验和试运行成功后切换入口，保留旧版。
npm 安装则定位当前运行的安装，更新到 npm `latest` 稳定版本，并验证安装结果。
更新完成后重新启动 `laohuang`。npm 更新在已是最新版本时不重复安装，也不会自动降级。
npm 更新支持全局安装、项目直接依赖和 workspace 直接依赖；局部更新会修改对应的
`package.json` 与 lockfile。源码、link、npx 临时安装及其他包管理器管理的安装
需要通过各自的更新方式处理，命令会给出提示。

## 使用

直接输入任务，例如：

```text
梳理这个项目的目录结构，说明主要模块之间的关系。
```

Agent 提供 `read`、`write`、`edit`、`bash` 四个工具，支持流式回复、运行中追加任务和取消执行。

- `/model`：搜索并选择所有已配置供应商的可用模型。
- `/login`：配置供应商凭据。
- `/providers`：查看供应商及其配置、验证状态。
- `/cancel`：取消当前任务。
- `/name MCP 接入设计`：保存当前会话名称；`/name` 查看名称。
- `/copy`：复制最近一条已完成助手回复的正文，保留 Markdown。
- `/help`：查看全部命令。
- `/exit`：退出。

用 `/login` 添加供应商凭据后，`/model` 会直接展示已配置供应商的完整模型列表，
可按供应商 ID、模型 ID 或模型名称搜索。通过环境变量配置凭据的供应商也会出现在列表中。
列表支持滚动；没有可用模型时会提示先执行 `/login`。
`/model <provider>` 可只查看一个供应商的模型，`/model <provider> <model>` 可直接切换。
模型切换只影响当前会话，不修改默认 Profile。

会话名称在恢复和会话列表中保留；clone 继承当前名称，fork 继承分叉时的名称。
`/copy` 不复制思考过程、工具结果或尚在流式生成的片段；生成中会复制上一条
已记录回复。SSH 会话通过 OSC 52 向当前终端发送复制请求；这只能确认请求已发送，
实际写入取决于终端设置。没有可用剪贴板后端时会说明原因。

供应商和模型来自 pi-ai 的 API-key catalog；可用范围、认证方式与验证状态见
[模型配置文档](docs/configuration.md)。

> 工具调用直接执行，不会请求确认。Bash 没有操作系统级沙箱，文件访问也不限于项目目录。
> 使用前请阅读 [安全模型](docs/security.md)。

## 文档

- [模型与凭据配置](docs/configuration.md)
- [项目架构](docs/architecture.md)
- [Bash 输出](docs/bash-output.md)

## 开发

从源码运行、测试与终端验收见 [开发指南](docs/development.md)。
发布相关说明见 [发布流程](docs/publishing.md) 和 [npm 分发说明](docs/npm-distribution.md)。

## License

[MIT](LICENSE)

# laoHuangCode

运行在终端里的开源 AI 编程助手。

[![npm](https://img.shields.io/npm/v/laohuang)](https://www.npmjs.com/package/laohuang)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

用自然语言描述任务，让 Agent 阅读代码、修改文件和执行命令。

## 安装

需要 Node.js >=22.19.0 和 Bash。

```bash
npm install -g laohuang
```

进入项目目录，启动交互会话：

```bash
cd your-project
laohuang
```

首次启动会引导你选择供应商、隐藏输入 API key 并选择模型，无需手动设置环境变量。

## 使用

直接输入任务，例如：

```text
梳理这个项目的目录结构，说明主要模块之间的关系。
```

Agent 提供 `read`、`write`、`edit`、`bash` 四个工具，支持流式回复、运行中追加任务和取消执行。

- `/model`：选择模型。
- `/login`：配置供应商凭据。
- `/providers`：查看供应商及其配置、验证状态。
- `/cancel`：取消当前任务。
- `/help`：查看全部命令。
- `/exit`：退出。

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

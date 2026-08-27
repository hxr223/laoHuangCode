# laoHuangCode

一个轻量级的 coding agent，基于 TypeScript/Node.js、provider-neutral 模型运行时和
`@earendil-works/pi-ai` 原生工具调用。

当前提供四个工具：`read`、`write`、`edit`、`bash`。所有工具均直接执行，当前原型
暂不提供权限确认。

同一次模型响应中的只读工具与多个 Bash 调用默认并发执行。实时事件按工具实际完成
顺序发出，回传模型的 `tool` 消息保持原始调用顺序。只要一个批次包含 `write` 或
`edit`，Agent 会保守地串行执行整个批次，避免读写或多次修改之间出现竞态。

交互终端采用后台 AgentSession：模型回复和 Bash 的 stderr/状态会实时显示，stdout
会保留在工具结果中但默认不刷到终端，
Agent 运行时仍可继续输入。后续输入由事件路由器放入 pending/held 队列，并在安全点
成批交给模型；运行中的 `Ctrl+S` 会把当前输入或最早排队消息作为 steer 优先插队到
下一个安全点；当前任务可以通过 `/cancel` 或运行中的 `Ctrl+C` 协作式取消。
连续重复的工具调用和 Token、耗时预算会触发安全保护；保护触发后
Agent 会禁用工具并尝试基于已有信息完成一次最终回答。

## 快速开始

需要 Node.js >=22.19.0。面向普通用户的安装方式：

```bash
npm install --global laohuang
laohuang
```

首次启动会在终端中依次选择 DeepSeek 或 OpenAI、隐藏输入 API key、选择模型，
不需要设置环境变量。配置完成后，进入任意项目目录直接运行 `laohuang`。

从源码运行：

```bash
git clone https://github.com/hxr223/laoHuangCode.git
cd laoHuangCode
npm ci
npm run build
node apps/cli/dist/bin.js
```

## 模型配置

首次运行时，终端会提供两个当前产品支持的供应商：

- DeepSeek：内置 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
- OpenAI：从已安装的 pi-ai catalog 读取可用模型，也可手动输入模型名。

pi-ai 可能安装了更多供应商或模型；只有 DeepSeek 和 OpenAI 已接入配置、认证、
模型切换和契约测试流程，其他 catalog 条目不代表产品支持。

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
/cancel                             取消当前运行任务
/queue                              查看 pending/held/dead-letter 与估算 token
/queue resume                       恢复取消后保留的消息
/queue clear                        清空 pending/held/dead-letter
/clear                              清空当前对话上下文
```

认证和模型选择相互独立：`/login`、`/logout` 管理凭据，`/model` 只切换模型。
如果请求返回 401，Agent 会提示对应的 `/login <provider>` 命令。旧的
`/apikey set`、`/apikey remove` 暂时保留为兼容别名。
切换模型会保留可见对话历史，并移除供应商私有 replay 元数据。

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

当前交互终端使用简洁的上下边框标识输入区域。输入 `/` 会立即显示命令、说明和参数
补全；`Tab`/`Enter` 可接受当前补全，`/model` 会按“供应商 → 模型”分层补全。
终端还支持多行编辑和当前会话输入历史：

- `Enter`：发送任务。
- `Alt+Enter`：插入换行。
- Agent 运行中按 `Ctrl+S`：将当前输入作为 steer 插队；输入为空时提升最早排队消息。
- `↑` / `↓`：浏览历史输入。
- Agent 运行中按 `Ctrl+C`：取消当前任务。
- Agent 空闲时按 `Ctrl+C`：清空输入；500ms 内再按一次：退出。
- `Ctrl+D`：退出。

模型文本和 Bash stderr/状态采用 append-only inline 流式展示，工具输出按 tool call 分组；
被取消或截断的半条模型回复会保留在屏幕上并标记“未加入上下文”。输出被重定向或由程序
调用 CLI 时，会自动回退到稳定的纯文本格式。

### TUI 设计方向

当前 TUI 使用无全局外框的组件化布局：命令结果、模型和 effort 选择器、认证输入、
thinking、工具状态、输入区和状态行共享结构化语义样式，并保留终端原生 scrollback。
交互列表不使用编号；普通输入和回答使用终端默认前景色，描述和元数据使用 muted
语义色。

### 验证交互终端

不调用供应商的手动检查命令：

```bash
npm run build
tmux new-session -d -s laohuang-component-test -x 80 -y 24
tmux send-keys -t laohuang-component-test "node apps/cli/dist/bin.js" Enter
tmux send-keys -t laohuang-component-test "/help" Enter
tmux capture-pane -t laohuang-component-test -p
tmux send-keys -t laohuang-component-test Escape
tmux kill-session -t laohuang-component-test
```

捕获结果应显示无全局外框的 `/help` 结构化命令列表、单一输入提示符和保留的原生
scrollback，不应出现编号交互列表或终端协商片段。供应商支持的模型选择和认证操作
需要已配置凭据，不属于自动 `smoke:tui` 验证。

`npm run smoke:tui` 还会运行
`node scripts/tui-offline-terminal-transcript-smoke.ts`。这个离线 tmux 验证器
启动真实 `StdTerminalDriver` 和交互 loop，只注入本地假事件；它会提交两轮普通输入，
检查 reasoning 冻结、普通回答默认前景色、本地工具输出折叠/展开/收起、tmux resize、
原生 scrollback 和本地 secret fixture 不泄漏，不发起供应商请求。

1. 在真实 TTY 中运行 `laohuang`。
2. 发送第一个问题并等待回答完成。
3. 发送第二个问题；向上滚动确认第一个问题和回答仍保留且未被改写。
4. 输入 `/` 和 `/e`，确认候选只占可见行数，`Tab` 可接受 `/exit`，继续编辑会移除补全层。
5. 任务运行中按 `Ctrl+S` 插队、按 `Ctrl+C` 取消；空闲且编辑器为空时按 `Ctrl+D` 退出。

当前版本不会在工具执行前请求确认。请只在你信任的项目和环境中运行。

## 开发与发布检查

```bash
npm ci
npm run build
npm test
npm run smoke:package
```

`npm run build` 通过 TypeScript project references 构建 `apps/cli` 和
`packages/*/*`，再把 CLI bundle 写入 `apps/cli/dist/bin.js`；`npm test` 使用
Node 自带的 `node:test` 运行 `scripts/` 下的离线测试套件，不需要网络访问。
`scripts/` 还包含 workspace 架构检查、版本检查、npm 打包/安装烟测、tmux 终端烟测、
发布后 registry 验证、测试统计和 CLI CPU profile 脚本。发布流程见
[发布流程](docs/publishing.md) 和 [npm 分发说明](docs/npm-distribution.md)。

源码结构是私有 npm workspace：`apps/cli` 是唯一应用和唯一发布包，内部运行时、
工具、模型适配器、配置、会话和 TUI 边界放在 `packages/<domain>/<package>`。

## 安全边界

文件工具接受绝对路径，相对路径以启动目录为基准，并可访问当前用户有权访问的启动目录外文件；API key 不通过环境变量传递给
Bash。但 `bash` **没有操作系统级沙箱**，执行后仍能访问项目外文件、网络和其他
系统资源。公开使用前请阅读 [安全模型](docs/security.md)。

架构说明见 [docs/architecture.md](docs/architecture.md)。

## License

MIT

# laoHuangCode TypeScript 全量重写设计

日期：2026-08-21。基线：develop `6ce0ef5`(Python 侧冻结,只修 bug 不加特性)。
分支: `ts-rewrite`(worktree `.worktrees/ts-rewrite`)。

## 1. 目标

将 laoHuangCode 从 Python 一次性全量重写为 TypeScript/Node.js,npm 成为原生分发,
消除"用户机器需 Python 3.11+"的安装失败面。重写完成后删除 Python 实现、
npm launcher、wheel 打包与双生态发布管线。

## 2. 已拍板决策

- **全量重写,非逐行移植**:用 TS 惯用法重新实现,该用库用库;不被 Python 代码风格拉回。
- **无对应物的部分手写**:终端 UI(prompt-toolkit/rich 无 1:1 对应)手写 ANSI,不引入 Ink。
- **并发重新设计**:Python 侧为线程模型(threading/queue/ThreadPoolExecutor),TS 侧基于
  事件循环与 Promise 重新表达,语义以第 5 节行为说明为准,不做机制平移。
- **测试先行**:先将 Python unittest 行为规格翻译为 TS 测试(红),再实现到绿。
- **范围**:一次全量,不做渐进混合(Python/TS 并存)方案。

## 3. 技术选型

- 运行时: Node.js >= 18(与现有 npm 包要求一致),ESM,TypeScript strict。
- 构建: `tsc`(不引入额外 bundler)。
- 测试: `node:test` + `node:assert`(内置,对应原 unittest 精神)。
- 模型 SDK: 官方 `openai` npm 包(Chat Completions 原生 tool calling,与 Python 版一致)。
- Web 面板: `node:http` + 内嵌 HTML/JS(对应原 http.server 方案)。
- 子进程: `node:child_process`,POSIX 下 `detached` + 进程组信号(对应 setsid/SIGTERM→SIGKILL)。
- 终端: 手写 ANSI + raw mode TTY(`node:tty`),自己实现补全菜单、多行编辑、流式渲染。
- 除 `openai` 与 `typescript` 外尽量无运行时依赖,但不设硬性禁令。

## 4. 模块映射(Python → TS)

| Python(src/laohuangcode) | TS(src/) | 备注 |
| --- | --- | --- |
| `agent.py` (965) | `agent.ts` | model↔tool 循环、流式组装、并发工具批、护栏 |
| `session.py` (903) | `session.ts` | AgentSession 状态机、safe point、claim/ack、取消协调 |
| `events.py` (841) | `events.ts` | EventEnvelope、EventBus 有界信箱、背压/合并、projector |
| `routing.py` (749) | `routing.ts` | 4 层路由、Scheduler、pending/held/dead-letter |
| `cli.py` (728) | `cli.ts` | 参数解析、REPL 装配、config/doctor 子命令 |
| `model_stream.py` (570) | `model-stream.ts` | Chat Completions 流缓冲/组装/提交、stale 处理 |
| `commands.py` (509) | `commands.ts` | 斜杠命令注册表、分层补全 |
| `bash_runner.py` (483) | `bash-runner.ts` | 进程组、增量 UTF-8、head/tail 截断、信号升级 |
| `terminal_input.py` (417) | `terminal/input.ts` | 手写:raw mode、按键、补全菜单、历史 |
| `terminal_ui.py` (1109) | `terminal/ui.ts` | 手写:inline 流式渲染、工具输出分组、主题 |
| `terminal_markdown.py` / `terminal_theme.py` | `terminal/markdown.ts` / `terminal/theme.ts` | 手写 |
| `tools.py` (220) | `tools.ts` | read/write/edit、路径圈禁、symlink 检查 |
| `web.py` (231) | `web.ts` | `node:http` 面板 |
| `config.py` / `credentials.py` / `providers.py` / `client.py` | `config.ts` / `credentials.ts` / `providers.ts` / `client.ts` | 直接对应 |
| `ui_state.py` / `cancellation.py` / `model_selection.py` / `semantic_classifier.py` | `ui-state.ts` / `cancellation.ts` / `model-selection.ts` / `semantic-classifier.ts` | 直接对应 |

测试: `tests/*.py`(21 文件,4648 行)→ `test/*.test.ts`,一一对应;
`test_version_sync.py`/`test_npm_release.py` 由 npm 侧的版本/打包检查替代。

## 5. 并发行为说明(重写依据,语义不可丢)

1. **AgentSession**: 同一时刻单活跃任务;输入经路由进 pending/held;安全点成批交付模型;
   claim/ack 失败可回滚;`/cancel` 与运行中 Ctrl+C 为协作式取消(取消令牌 + 安全点检查)。
2. **EventBus**: 每订阅者有界信箱;溢出时背压/合并(可合并事件类型);projector 负责
   脱敏;canonical pull buffer 供 Web 面板拉取。
3. **工具批执行**: 同批只读工具与多个 bash 并发;批次含 write/edit 则整批串行;
   事件按实际完成顺序发出,回传模型的 tool 消息保持原始调用顺序。
4. **bash_runner**: POSIX 进程组;stdout/stderr 增量 UTF-8 解码;4KB/40ms delta 发布;
   输出 head 40%/tail 60% 截断;超时 SIGTERM→SIGKILL 升级。
5. **model_stream**: 流式增量缓冲,完整轮次原子提交历史;stale 请求(已被新请求取代)
   的迟到增量丢弃;取消时半条回复保留展示但不入上下文。

TS 侧表达:取消用 CancelToken(Promise + AbortSignal 风格),信箱用异步迭代器 +
有界队列,并发批用 Promise.all/串行 for,不需要 worker threads。

## 6. 执行顺序

1. 脚手架: `package.json`(ESM, bin)、`tsconfig.json`(strict)、目录结构。
2. 测试翻译: 21 个测试文件 → `test/`,先全红。
3. 基础模块: config/credentials/providers/client → tools → events → model_stream。
4. 核心: agent → session → routing → commands → bash_runner。
5. 终端: input → ui → theme/markdown → ui_state。
6. cli.ts 装配 + web.ts。
7. npm 打包(bin 直接指向构建产物,删除 launcher/venv 逻辑)。
8. README、docs(architecture/configuration/security/publishing)重写。
9. 删除 Python 实现、scripts 双生态管线、CI Python 腿;版本策略发布前定。
10. 全量验证: `npm test`、`tsc` 构建、临时目录 npm 安装实测、真实 TTY 手工清单
    (沿用 README「验证交互终端」五条)。

## 7. 验证命令

```bash
npm run build   # tsc
npm test        # node --test
npm pack && npm install -g <tarball>  # 安装实测
```

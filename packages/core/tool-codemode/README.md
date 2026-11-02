# @laohuang/tool-codemode

将独立 `@laohuang/codemode` 接入宿主 ToolRuntime。包只暴露根入口。

`createCodeModeTool({workerPool,bindSession,workerUrl?,wasm?})` 返回可注册的工具及
`close()`。context 必须提供当前 `callableTools` 和受管理的 `executeTool`；适配器
不绕过校验或直接调用注册表。模型只传 `{code:string}`。

`bindSession(context)` 同步捕获本次会话的 `readStore`、图片端口和 `outputDirectory`。
不要在晚回调里重新读取当前会话。成功根结果通过 tools 的不可枚举 Symbol 附上
storeWrites；内部附件另存为 GC 引用，只有脚本 `image()` 选中的图片进入模型。
宿主负责将元数据和根结果原子提交。关闭工具会取消等待和活动脚本；共享 pool 由宿主关闭。

`CodeModeWorkerPool` 默认共享容量 2，FIFO 等待最多 60000ms；reserve 接收剩余总预算、
signal 和 onQueued。租约的 acquireWorker 回调交给 SDK，只有真实 Worker exit 才释放，
启动前失败调用 releaseUnused。SDK 不等待忽略取消的宿主工具实际结束，公共 runtime
继续追踪它们并保持叶子调度锁。适配器声明 manageCancellation，承诺 abort 后及时返回
保留显式输出的逻辑结果，不等待这些物理子调用。

有 outputSchema 且 structuredContent 不为 undefined 时脚本收到结构化值，保留 null、
false、0。否则返回完整宿主文本，不自动解析 JSON。失败总抛 ToolScriptError，可在脚本
catch；原始结果不附在异常上。searchTools 复用 BM25，只检索当前 callable 快照，
不激活 tool_search 或改变模型工具表。

输出、状态、内存和队列精确限制见运行时 README 与根 README。图片端口执行引用授权和
真实解码；超量文本流式保存，落盘失败不重新执行工具。QuickJS 不隔离宿主工具的 OS 权限。

# @laohuang/codemode

Node.js >=22.19.0 的独立 Code Mode 运行时。每次执行创建一个 Worker；Worker 内的独立 QuickJS WASM 实例运行模型生成的 JavaScript。工具函数留在宿主，通过 JSON 消息与脚本的 Promise 通信。

```ts
import { CodeModeSandbox } from "@laohuang/codemode";

const sandbox = new CodeModeSandbox({
  tools: [{ name: "double", execute: value => Number(value) * 2 }],
});
try {
  const result = await sandbox.execute("text(await tools.double(21)); return 42;", {
    signal: new AbortController().signal,
    store: { count: 1 },
  });
  // result.output 保存显式输出；成功的 result.value 单独保存返回值。
  // 成功的 result.storeWrites 由宿主原子提交；失败结果不含 storeWrites。
  console.log(result);
} finally {
  await sandbox.close(); // 取消活动脚本并关闭入口。
  await sandbox.drain(); // 等待已启动的 Worker 实际退出。
}
```

默认不限执行时长；可在构造或 execute 时指定 timeoutMs。超时覆盖加载、初始化、脚本计算和等待工具。CLI 的 Worker 排队由宿主组织，传入剩余预算；这个包不自行限制进程级 Worker 数量。acquireWorker 返回的释放函数只在 Worker 实际 exit 或创建失败时调用。

脚本可用 tools、ALL_TOOLS、text、image、console、exit、store/load，以及宿主注入的 globals。工具支持原名的方括号调用与确定性别名；别名不覆盖其他工具的原名。searchTools 是宿主注入的发现能力，不是包内的 Agent 策略。

store/load 操作单次执行的 JSON 快照，load 返回副本；store(key, undefined) 删除键。成功或 exit 返回写入集合，失败、取消、超时不返回可提交的写入。工具外部副作用不会回滚。会话分支持久化由宿主实现。

每个实例的默认内存上限 256 MiB，宿主可降低；显式输出加返回值的硬预算为 16777216 UTF-16 字符或 100000 项。store 单值最多 262144 JSON 字符，含 key 总量最多 1048576 字符。模型可见的截断、完整输出落盘由接入层处理。

image 接收 base64 data URL、image_url、data/mimeType 图片块或 attachment_id 引用，拒绝网络 URL；实际图片解码和引用授权由宿主媒体端口处理。没有 image() 的内部图片不会因此自动成为输出。

脚本没有 process、require、fetch、timers 或任意模块加载能力。QuickJS 隔离脚本执行；宿主工具仍按宿主权限执行，这不是 Bash 或文件系统的 OS 沙箱。close/drain 不保证一个忽略取消信号的宿主工具已经停止。

源码选项通过 parseCodeModeSource 解析首行 // @options: JSON；声明通过 renderDeclarations/renderToolSample 生成。包仅暴露根入口；打包宿主可将 runCodeModeWorker 作为独立 Worker 入口，并显式传入 workerUrl/WASM。

部分设计与源码适配自 Pi Code Mode，MIT 归属见 LICENSE。

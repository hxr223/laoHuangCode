# @laohuang/attachment

附件公共契约，不依赖会话、模型 SDK、文件系统或图片解码器。具体实现见 `@laohuang/attachment-local`。

- `FileRef` 是 SHA-256 内容身份、字节数、显示名称；`ImageRef` 增加真实格式、方向校正后尺寸及动画标记。
- `AttachmentContent` 用于用户消息及工具结果。历史持久化引用，不持久化 Base64。
- `ImageTarget` 是模型适配层传入的请求约束，包含像素、最长边、字节、允许格式、裁剪和原分辨率选项。
- `AttachmentStore` 提供流式文件读写、批量图片入库、请求版本生成、提交协调和垃圾回收。

## 调用约定

`readFile` 在读完时校验摘要；消费者必须完成迭代才能把结果视为完整验证的数据。
`saveImages` 先验证整批，写入失败不返回部分结果；已经发布但没有引用的对象按保留策略清理。
`protect()` 保护在途使用，必须在 `finally` 释放；它不是草稿租约。
`commit(refs, write)` 在同步临界区验证对象并执行正式消息写入。`write` 必须同步持久化，不可返回 Promise。
`collectGarbage` 的回调必须返回全部项目、全部持久会话的引用集合；无法确认完整性必须抛错。`force` 只跳过每日调度门槛，不绕过引用或 30 天保留期。

按 ID 的用户访问授权由调用方检查当前会话持有关系，不能直接开放底层存储读取。

## 接入位置

`llm` 定义消息中的 `attachments`；`tools` 的 `attachmentContent` 避免与现有 MCP 文件产物字段冲突。
`agent-runtime` 保留工具媒体内容，`session-store` 同步持久化并扫描引用。
`llm-pi-ai` 决定预算，向附件服务请求图片版本，再转换 Base64/MIME。普通文件只发送描述，不自动解析文件正文。
`tool-fs` 的独立 `read_image` 是当前 CLI 入口；不包含聊天框上传界面。

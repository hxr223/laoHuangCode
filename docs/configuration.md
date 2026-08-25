# 模型与凭据配置

## 首次启动

用户不需要设置 API key 环境变量。第一次执行 `laohuang` 时，终端依次完成：

```text
选择供应商（DeepSeek / OpenAI）
→ 隐藏输入 API key
→ 选择模型名称
→ 保存默认 Profile
→ 启动 Agent
```

DeepSeek 提供 `deepseek-v4-flash` 和 `deepseek-v4-pro`。OpenAI 在获得 key 后通过
SDK 读取账户可用模型；如果读取失败，可以手动输入模型名称。

## 运行中切换

```text
/model
/model current
/model deepseek deepseek-v4-pro
/model openai <model-name>
```

`/model` 默认只改变当前会话，不修改默认 Profile。切换成功前会完成凭据检查和新
客户端创建；任何失败都不会替换当前客户端。切换后保留已经完成的对话历史，并将
历史消息规范化为两家服务都接受的 Chat Completions 通用字段。

`/model` 不负责录入凭据。选择尚未登录的供应商时，会提示先运行相应的
`/login <provider>`。

## 登录与凭据管理

```text
/login
/login deepseek
/login openai
/logout deepseek
/logout openai
```

key 在终端使用隐藏输入（不回显），不会出现在 Shell 历史、普通终端输出或 Agent
消息中。`/login` 更新当前供应商时会立即重建客户端；`/logout` 删除
当前供应商的已保存 key 时不会抹除内存中的现有客户端，退出或切换模型后才完全
失效。模型请求返回 401 时，错误信息会提示运行对应的 `/login <provider>`。

旧命令 `/apikey`、`/apikey set <provider>` 和 `/apikey remove <provider>` 暂时
保留为兼容别名，新用法应优先使用 `/login`、`/logout`。

## 本地文件

默认配置目录是 `~/.config/laohuang`：

```text
~/.config/laohuang/
├── config.json          # 供应商、模型和 Profile
└── credentials.json     # API key
```

程序创建的默认目录权限为 `0700`，两个文件为 `0600`。凭据文件当前是严格权限保护的明文 JSON；
后续可以升级为 macOS Keychain 或 Linux Secret Service。

模型配置示例：

```json
{
  "version": 1,
  "active_profile": "default",
  "profiles": {
    "default": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "base_url": "https://api.deepseek.com"
    }
  }
}
```

也可以使用非交互 Profile 命令管理已保存模型；如果缺少对应 key，下次启动时仍会在
终端中隐藏询问：

```bash
laohuang config list
laohuang config use default
laohuang doctor
```

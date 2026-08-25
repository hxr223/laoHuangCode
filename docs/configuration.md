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

DeepSeek 提供 `deepseek-v4-flash` 和 `deepseek-v4-pro`。OpenAI 模型来自已安装的
pi-ai catalog；如果没有列出目标模型，可以手动输入模型名称。

当前产品支持的路由只有 DeepSeek 和 OpenAI。pi-ai 依赖中可能存在其他供应商或模型，
但只要没有完成配置、认证、请求/响应转换和真实供应商契约测试，就不代表
`laohuang` 已支持。

## 运行中切换

```text
/model
/model current
/model deepseek deepseek-v4-pro
/model openai <model-name>
```

`/model` 默认只改变当前会话，不修改默认 Profile。切换成功前会完成凭据检查；下一次
请求会通过共享 Adapter 解析所选 route 和当前 API key。任何失败都不会替换当前
route。切换后保留已经完成的可见对话历史，并移除供应商私有 replay 状态。

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
消息中。`/login` 更新当前供应商时，下一次模型请求会通过共享 Adapter 读取新 key；
`/logout` 删除当前供应商的已保存 key 后，后续请求会失败并提示重新登录。模型请求
返回认证错误时，错误信息会提示运行对应的 `/login <provider>`。

旧命令 `/apikey`、`/apikey set <provider>` 和 `/apikey remove <provider>` 暂时
保留为兼容别名，新用法应优先使用 `/login`、`/logout`。

## 本地文件

配置实现位于私有 workspace `@laohuang/local-config`，CLI 只通过该包读取和写入
profile 与凭据文件。

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

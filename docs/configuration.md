# 模型与凭据配置

## 首次启动

用户不需要设置 API key 环境变量。第一次执行 `laohuang` 时，终端依次完成：

```text
选择 pi-ai API-key 供应商
→ 按供应商要求隐藏输入 API key 或附加 setup 字段
→ 搜索并选择模型
→ 保存默认 Profile
→ 启动 Agent
```

供应商、显示名称、模型和 API family 均来自 `@earendil-works/pi-ai@^0.83.0`。
当前 eligible 规则是 `provider.auth.apiKey.login` 存在；pi-ai 0.83.0 的快照为
35 个 API-key providers。`amazon-bedrock`、`google-vertex` 明确排除，OAuth-only
providers 自动排除；直接 Google API provider `google` 与 Vertex 是不同路由。

## 运行中切换

```text
/model
/model current
/model deepseek deepseek-v4-pro
/model anthropic claude-sonnet-4-5
```

`/model` 默认只改变当前会话，不修改默认 Profile。切换成功前会完成凭据检查；下一次
请求会通过共享 Adapter 解析所选 route 和当前 credential。任何失败都不会替换当前
route。切换后保留已经完成的可见对话历史，并移除供应商私有 replay 状态。

`/model` 不负责录入凭据。选择尚未登录的供应商时，会提示先运行相应的
`/login <provider>`。

## 登录与凭据管理

```text
/login
/login deepseek
/login anthropic
/logout deepseek
/providers
/providers deepseek
```

API key 和供应商 setup 字段保存在独立 credentials 文件，不进入 `config.json`。
`/providers` 的列表状态含义：

- `available`: pi-ai catalog 暴露 API-key login，且未被产品 policy 排除。
- `configured`: 已保存 credential 或 provider documented environment variables 可用。
- `verified`: 已经通过显式授权的真实 provider native tool-call/tool-result E2E，并写入证据。

当前 `PROVIDER_VERIFICATIONS` 为空，因此所有 eligible provider 默认都是 available，
可 configured，但未 verified。真实 provider 验证必须显式 opt in。

旧命令 `/apikey`、`/apikey set <provider>` 和 `/apikey remove <provider>` 暂时
保留为兼容别名，新用法应优先使用 `/login`、`/logout`。

## 本地文件

配置实现位于私有 workspace `@laohuang/local-config`，CLI 只通过该包读取和写入
profile 与凭据文件。

默认配置目录是 `~/.config/laohuang`：

```text
~/.config/laohuang/
├── config.json          # 供应商、模型和 Profile
├── credentials.json     # version 2 API-key credential 和 provider env 字段
└── models.json          # 动态 provider model cache
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

凭据文件 version 2 形状：

```json
{
  "version": 2,
  "providers": {
    "cloudflare-ai-gateway": {
      "type": "api_key",
      "key": "replace-with-test-key",
      "env": {
        "CLOUDFLARE_ACCOUNT_ID": "account-id",
        "CLOUDFLARE_GATEWAY_ID": "gateway-id"
      }
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

`doctor` 只检查 provider、credential、catalog refresh 和 model 是否有效，不发真实模型
请求。动态 provider（例如 Radius）的 model catalog 会持久化在 `models.json`；refresh
失败时保留已有缓存并报告错误。

真实 provider E2E 是付费/联网测试，不属于普通测试套件：

```bash
LAOHUANG_E2E_PROVIDER=deepseek \
LAOHUANG_E2E_MODEL=deepseek-v4-flash \
DEEPSEEK_API_KEY=replace-with-test-key \
npm run test:e2e:pi-ai
```

# 模型配置

## Provider 预设

| Provider | 默认模型 | Base URL | API key 环境变量 |
| --- | --- | --- | --- |
| `deepseek` | `deepseek-v4-flash` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `openai` | 必填 | SDK 默认地址 | `OPENAI_API_KEY` |
| `custom` | 必填 | 可选 | `OPENAI_API_KEY` |

DeepSeek 当前官方 OpenAI 兼容 API 支持 `deepseek-v4-flash` 和
`deepseek-v4-pro`，并支持 Tool Calls。模型可能变化，发布后应以
[DeepSeek 官方模型页](https://api-docs.deepseek.com/quick_start/pricing) 为准。

## 创建与选择 Profile

```bash
laohuang config --provider deepseek
laohuang config --profile pro --provider deepseek --model deepseek-v4-pro
laohuang config list
laohuang config use pro
```

默认路径为 `~/.config/laohuang/config.json`，也可以用 `XDG_CONFIG_HOME` 或
`LAOHUANG_CONFIG` 改变位置。文件权限设置为 `0600`，结构类似：

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

API key 永远不写入该文件，必须由环境变量提供。

## 解析优先级

每次启动按以下顺序覆盖模型连接参数：

1. CLI：`--profile`、`--model`、`--base-url`。
2. 环境变量：`LAOHUANG_PROFILE`、`LAOHUANG_MODEL`、`LAOHUANG_BASE_URL`。
3. 当前 Profile 中保存的值。

API key 只读取所选 Provider 对应的环境变量。使用 `laohuang doctor` 可以确认最终
解析出的 Provider、模型、地址和 key 是否存在，但不会打印 key 内容。

## 旧版环境变量模式

如果配置文件不存在，以下变量仍可直接启动 Agent：

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="your-model-name"
export OPENAI_BASE_URL="https://compatible.example/v1"  # 可省略
laohuang
```

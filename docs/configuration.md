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
/model deepseek-v4-pro
/model deepseek
/model deepseek deepseek-v4-pro
/model anthropic claude-sonnet-4-5
```

`/model` 默认列出当前供应商的可用模型，输入序号即可在当前供应商内切换模型。
`/model <model>` 会把参数解释为当前供应商下的模型；`/model <provider>` 会进入
指定供应商的模型列表；`/model <provider> <model>` 直接切到完整 route。

运行中模型切换默认只改变当前会话，不修改默认 Profile。切换成功前会完成凭据检查；
下一次请求会通过共享 Adapter 解析所选 route 和当前 credential。任何失败都不会替换
当前 route。切换后保留已经完成的可见对话历史，并移除供应商私有 replay 状态。

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

`doctor` 检查 provider、credential、catalog refresh、model 和 Bash 路径是否有效，不发真实模型
请求。动态 provider（例如 Radius）的 model catalog 会持久化在 `models.json`；refresh
失败时保留已有缓存并报告错误。

## Bash 路径

可在 `config.json` 顶层添加 `shell_path`，与 `profiles` 同级，指定 Bash 可执行文件的
绝对路径，也支持 `~/`（Windows 还支持 `~\`）展开用户主目录。例如：

```json
"shell_path": "/opt/homebrew/bin/bash"
```

Windows 路径在 JSON 中需要转义反斜杠：

```json
"shell_path": "C:\\Program Files\\Git\\bin\\bash.exe"
```

未配置时，macOS/Linux 优先使用 `/bin/bash`，其次按 `PATH` 顺序查找 `bash`；
Windows 优先查找 `ProgramFiles`、`ProgramFiles(x86)` 下的 `Git\bin\bash.exe`，
其次按 `PATH` 查找 `bash.exe`。忽略空或相对的 PATH 目录，不自动从项目目录选择 Bash；
不回退到 `sh`，也不使用 Windows System32/Sysnative 下的旧版 WSL Bash 启动器。
显式配置的路径无效时直接报错，不自动回退。命令继续使用 `-lc` 参数。

`laohuang doctor` 显示同一定位逻辑选中的路径；找不到 Bash 时返回非零状态。
Bash 工具在定位失败时返回 `spawn_failed`。路径检测不执行 Bash，也不验证其版本。
配置更改在下次启动生效。

## Windows 路径与终端

目标运行环境是 Windows 原生 Node.js 和 Git for Windows，不需要 WSL。
文件工具的 `path` 和 Bash 工具的 `workdir` 接受 Windows 原生路径、UNC、相对路径、
`~/`、`~\`，以及 `/c/...`、`/mnt/c/...`、`/cygdrive/c/...` 盘符路径。
`/usr/...` 等 Git Bash 虚拟路径通过所选 Bash 安装中的 `cygpath.exe` 转换；找不到
转换器时明确报错，应改用 Windows 绝对路径。不改写命令正文、工具输出或文件内容。
配置环境变量 `LAOHUANG_CONFIG`、`XDG_CONFIG_HOME` 使用相同路径转换；在读取
`shell_path` 前，虚拟配置路径的转换器按 Git 默认安装位置和 PATH 查找。
Windows 主目录优先使用 `USERPROFILE`，其次 `HOME`，最后系统主目录；配置和会话
目录采用同一规则。

交互终端在 raw mode 后启用 Windows VT 输入，保留 Shift+Tab 等修饰键信息；本地
Windows 控制台对没有显式修饰信息的 Enter 补查 Shift 状态。退出、取消或初始化失败
时恢复原有 raw/console mode。显式 Kitty/VT 键序列和 bracketed paste 保持独立处理；
SSH 和非控制台管道不查询本机键盘状态，Shift+Enter 取决于终端发送的键序列。
原生调用由 Koffi 预编译包提供，npm 安装需保留 optional dependencies；正常安装无需
本地 C/C++ 编译器。缺失原生模块或控制台模式设置失败会报错，不静默宣称修饰键可用。

代码已覆盖 Bash 定位、进程树取消、路径转换和终端输入适配，并加入 Windows CI。
当前开发机仅完成 macOS 验证，尚未完成 Windows Terminal/Git Bash 的实机交互验收，
因此还不能宣称满足完整 Windows 支持契约。

真实 provider E2E 是付费/联网测试，不属于普通测试套件：

```bash
LAOHUANG_E2E_PROVIDER=deepseek \
LAOHUANG_E2E_MODEL=deepseek-v4-flash \
DEEPSEEK_API_KEY=replace-with-test-key \
npm run test:e2e:pi-ai
```

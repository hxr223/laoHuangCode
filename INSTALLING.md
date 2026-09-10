# 安装与独立发行包

独立安装器使用与 npm 包相同的 CLI bundle，安装包携带固定版本的官方 Node.js
运行时和生产依赖。用户无需预装 Node/npm，也不会修改系统 Node 或 npm 的全局配置。
安装包是一个自包含目录，并非单个静态链接的可执行文件。

## 平台与依赖

| 平台 | 架构 | 依赖 |
| --- | --- | --- |
| macOS | x64、ARM64 | Bash、curl、tar、shasum |
| Linux | x64、ARM64 | glibc（Node 22 所需系统版本）、Bash、curl、tar、SHA-256 工具 |
| Windows | x64、ARM64 | Windows PowerShell 5.1+、Git for Windows |

Linux musl/Alpine 不在独立安装包的支持范围，使用发行版提供的 Node.js 和 npm 安装。
安装器会在缺少 Bash 时停止并说明安装方法，不会自行安装系统软件包。

## 安装

macOS / Linux：

```sh
curl -fsSL https://github.com/hxr223/laoHuangCode/releases/latest/download/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://github.com/hxr223/laoHuangCode/releases/latest/download/install.ps1 | iex
```

下载脚本执行后会从已发布 Release 读取版本，按系统架构下载归档，并校验 SHA-256。
校验和来自同一 HTTPS 发布源，用于检测下载损坏，不是独立的签名信任机制。
新版本通过 `--version` 试运行后，安装器才会切换命令入口。

默认位置：

- macOS/Linux：`~/.local/share/laohuang`，命令位于该目录的 `bin/laohuang`。
- Windows：`%LOCALAPPDATA%\laohuang`，命令位于该目录的 `bin\laohuang.cmd`。

可通过 `LAOHUANG_INSTALL_DIR` 指定绝对路径；POSIX 路径不能含换行或冒号，
Windows 路径还需避开 CMD/Path 分隔与展开字符（脚本会验证）。
通过 `LAOHUANG_VERSION=X.Y.Z` 指定版本；只接受稳定版本。

安装器会添加 PATH 配置，不重复添加相同配置行：

- zsh：`$ZDOTDIR/.zshrc`，未设置 ZDOTDIR 时使用 `~/.zshrc`。
- bash：写入 `~/.bashrc`，并写入已有的登录配置文件（依次检查 `.bash_profile`、
  `.bash_login`、`.profile`）；没有登录配置时，macOS 创建 `.bash_profile`，Linux 创建 `.profile`。
  这样登录和非登录交互终端都能找到命令，也不会遮蔽已有登录配置。
- fish：`$XDG_CONFIG_HOME/fish/conf.d/laohuang.fish`，默认配置根为 `~/.config`。
- 其他 POSIX shell：`~/.profile`。
- Windows：用户级 `Path`，并更新执行脚本的 PowerShell 进程环境。

POSIX 子进程无法修改父终端环境；安装器会打印当前终端可执行的 PATH 命令。
Windows 终端宿主可能缓存旧环境，需要退出并重新打开终端应用。
设置非空 `LAOHUANG_NO_MODIFY_PATH` 可跳过自动配置；此时需要自行添加安装目录的 `bin`。
已有其他安装时，安装器会说明命令冲突。Windows 系统 Path 中的旧安装可能优先于用户 Path，
需要按旧安装的方式卸载或调整其路径。

独立启动器只在自身及子进程中加入携带的 Node 路径，MCP 子进程可以使用该 Node；
不会向用户的全局 PATH 添加独立包内的 Node。

## 升级、恢复与卸载

运行 `laohuang update` 或重新执行安装命令。独立启动器调用随包安装器，更新自身安装目录；
npm 安装继续使用现有 npm 更新流程。`LAOHUANG_VERSION` 也会影响独立更新，取消该变量
可重新跟随最新 Release。显式指定旧版本可以降级；安装器不会删除历史版本目录。

安装器使用独占锁阻止并发安装，下载、校验和试运行失败不会替换已有命令入口。
已经启动的会话继续使用自己的版本目录。旧入口保存在 `bin/laohuang.bak`
或 `bin\laohuang.cmd.bak`，对应版本目录保留在 `releases` 中。
POSIX 可直接执行 `laohuang.bak`，或复制它覆盖 `laohuang` 以恢复；Windows 将
`laohuang.cmd.bak` 复制覆盖 `laohuang.cmd`。不要删除仍有会话使用的版本目录。
强制终止安装可能留下锁；确认没有安装进程后，按错误提示移除该锁再重试。

卸载时删除自定义安装目录（默认位置见上文），并移除对应 PATH 配置行。
模型配置、凭据和会话仍使用原有存储位置，安装器不修改或删除它们。

## 构建与发布验收

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run check:version
npm run smoke:package
npm run smoke:tui
npm run build:standalone
npm run smoke:standalone
```

`build:standalone` 在当前目标系统原生构建，生成 `.build/standalone` 中的归档、
每个归档的 `.sha256` 和 `version.txt`。它校验官方 Node 下载，并加载 Koffi 和 MCP
客户端，检查生产依赖与当前架构的原生依赖确实可用。
Node 版本固定在 `scripts/build-standalone.mjs` 和 standalone workflow 中，升级时同时更新。

`smoke:standalone` 使用临时 HOME、隔离 PATH 和本地下载源，验证通过命令名启动、
首次配置入口、更新和损坏下载后的恢复；不调用模型 API，不修改开发者 shell 配置。
本地 Windows smoke 跳过真实用户 Path 修改；GitHub Actions 中会对临时 runner 账户
验证 Path 持久化及重复安装，并在 finally 中恢复。平台安装脚本测试与原生包验证在 CI 的六个平台执行。
`LAOHUANG_DOWNLOAD_BASE` 用于本地验收或显式配置镜像；只接受 HTTPS 或本地 file URL，
其布局必须与 GitHub Releases 一致。

CI 和 Release 共用 `.github/workflows/standalone.yml`。合并到 main 后，六个平台
原生安装验收全部通过，才允许发布 npm；npm 版本验证完成后，再创建 GitHub Release，
上传归档、校验和、版本文件和两个安装脚本。Release 草稿上传完成后才设为 latest，
避免安装器读到缺少文件的版本。npm 和 GitHub 发布不具有跨服务事务性；后者失败时
重跑失败的 GitHub 发布任务，不要重复发布已经存在的 npm 版本。

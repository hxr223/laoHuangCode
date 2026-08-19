# 发布流程

仓库包含 `main` push 触发的 `.github/workflows/release.yml`：只有确认当前提交来自
合并到 `main` 的 pull request 后，才会构建并测试 Python wheel，将 wheel 放入 npm
包的 `vendor/` 目录，再通过 npm Trusted Publishing 发布唯一的 npm 制品。直接向
`main` push 会触发工作流，但发布任务会明确拒绝该提交。

## 首次发布前设置

1. 确认 npm 包名 `laohuang` 可用。
2. 创建 GitHub 仓库 `hxr223/laoHuangCode`，并确认 package repository 元数据
   与真实仓库完全一致。
3. 首次版本通过 npm CLI 登录后发布，以创建包。
4. 在 npm 为该仓库的 `release.yml` 配置 Trusted Publisher，环境名为 `npm`，允许
   `npm publish`。
5. 将 GitHub `npm` Environment 的 deployment branch 限制为 `main`；如套餐支持，
   再增加人工审批。
6. 为 `main` 启用分支保护，只允许 pull request 合并，并要求 `CI` 工作流全部通过。

npm Trusted Publishing 需要 Node 22.14+ 和 npm 11.5.1+；工作流固定使用 Node 24。
具体设置以 [npm 官方 Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)
为准。

## 发布一个版本

1. 在功能 pull request 中同时修改 `pyproject.toml`、
   `src/laohuangcode/__init__.py`、`npm/package.json` 和
   `npm/package-lock.json` 中的版本。当前发布只接受稳定的 `X.Y.Z` SemVer。
2. 执行 `scripts/release-check.sh`。
3. 创建 pull request。CI 的 `release-readiness` 会确认四处版本同步，并确认 npm
   尚未发布该版本，且版本高于 npm 当前的 `latest`，防止意外降级。
4. 合并到 `main`；观察 GitHub `Release` workflow。无需手动创建或推送 tag。

每个合并到 `main` 的 pull request 都代表一个 npm 发布，因此必须提升版本。CD 不会
把“版本已存在”当作成功跳过，而会失败并要求提交新的版本。发布任务使用固定并发组，
不会取消正在执行的发布；它还设置了超时、最小 GitHub token 权限，并要求 npm
Trusted Publishing。当前 GitHub 仓库是 private，npm 不支持为 private repository
生成 provenance；仓库公开后，Trusted Publishing 会自动生成 provenance，无需增加
`--provenance` 参数。

如果 `npm publish` 已经成功、但最后的 registry 验证因网络问题失败，不要直接修改
版本或重复发布；先在 npm 确认该版本是否已经存在。npm 版本不可覆盖。

Python 内核不单独上传 PyPI。发布检查会确认 npm tarball 包含与 npm 版本一致的
`laohuangcode-<version>-py3-none-any.whl`。

# 发布流程

仓库包含 tag 触发的 `.github/workflows/release.yml`：构建并测试 Python wheel，
将 wheel 放入 npm 包的 `vendor/` 目录，再通过 npm Trusted Publishing 发布唯一的
npm 制品。普通 push 和 pull request 只运行 CI，不发布。

## 首次发布前设置

1. 确认 npm 包名 `laohuang` 可用。
2. 创建 GitHub 仓库 `hxr223/laoHuangCode`，并确认 package repository 元数据
   与真实仓库完全一致。
3. 首次版本通过 npm CLI 登录后发布，以创建包。
4. 在 npm 为该仓库的 `release.yml` 配置 Trusted Publisher，环境名为 `npm`，允许
   `npm publish`。
5. 后续版本通过 tag 自动发布；可为 GitHub 的 `npm` Environment 增加人工审批。

npm Trusted Publishing 需要 Node 22.14+ 和 npm 11.5.1+；工作流固定使用 Node 24。
具体设置以 [npm 官方 Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)
为准。

## 发布一个版本

1. 同时修改 `pyproject.toml`、`src/laohuangcode/__init__.py` 和
   `npm/package.json` 中的版本。
2. 执行 `scripts/release-check.sh`。
3. 提交改动并创建与版本一致的 tag，例如 `v0.3.0`。
4. 推送 tag；观察 GitHub `Release` workflow。

Python 内核不单独上传 PyPI。发布检查会确认 npm tarball 包含与 npm 版本一致的
`laohuangcode-<version>-py3-none-any.whl`。

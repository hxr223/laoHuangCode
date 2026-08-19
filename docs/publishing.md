# 发布流程

仓库包含 tag 触发的 `.github/workflows/release.yml`，顺序为：构建并测试 Python
包、通过 PyPI Trusted Publishing 上传、再通过 npm Trusted Publishing 上传启动器。
普通 push 和 pull request 只运行 CI，不发布。

## 首次发布前设置

1. 确认 PyPI 项目名 `laohuangcode` 和 npm 包名 `laohuang` 可用。
2. 创建 GitHub 仓库 `huangxurui/laoHuangCode`，并确认两个包的 repository 元数据
   与真实仓库完全一致。
3. 在 PyPI 为该仓库的 `release.yml` 配置 Trusted Publisher，环境名为 `pypi`。
4. 在 npm 为该仓库的 `release.yml` 配置 Trusted Publisher，环境名为 `npm`，允许
   `npm publish`。
5. 可在 GitHub 中为 `pypi`、`npm` 两个 Environment 增加人工审批。

npm Trusted Publishing 需要 Node 22.14+ 和 npm 11.5.1+；工作流固定使用 Node 24。
具体设置以 [npm 官方 Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)
和 [Python Packaging User Guide](https://packaging.python.org/en/latest/guides/publishing-package-distribution-releases-using-github-actions-ci-cd-workflows/)
为准。

## 发布一个版本

1. 同时修改 `pyproject.toml`、`src/laohuangcode/__init__.py` 和
   `npm/package.json` 中的版本。
2. 执行 `scripts/release-check.sh`。
3. 提交改动并创建与版本一致的 tag，例如 `v0.2.0`。
4. 推送 tag；观察 GitHub `Release` workflow。

不要先单独发布 npm 包。npm 启动器严格安装 `laohuangcode==<npm version>`，因此
Python 包必须已经可从 PyPI 获取。

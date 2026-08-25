# 发布流程

`laohuang` 是纯 npm 制品：私有根 workspace 编排构建，`apps/cli` 拥有发布版本、
`bin` 入口和 tarball 文件列表。`npm publish --workspace laohuang` 发布包含
`apps/cli/dist/bin.js`、source map、随包 `README.md` 和 `LICENSE` 的 tarball。
没有 wheel、venv 或 PyPI 环节。

仓库包含 `main` push 触发的 `.github/workflows/release.yml`：只有确认当前提交来自
合并到 `main` 的 pull request 后，才会构建、测试并通过 npm Trusted Publishing
发布 npm 制品。直接向 `main` push 会触发工作流，但发布任务会明确拒绝该提交。

## 首次发布前设置

1. 确认 npm 包名 `laohuang` 可用。
2. 创建 GitHub 仓库 `hxr223/laoHuangCode`，并确认 package repository 元数据
   与真实仓库完全一致。
3. 首次版本通过 npm CLI 登录后发布，以创建包。
4. 在 npm 为该仓库的 `release.yml` 配置 Trusted Publisher，环境名为 `npm`，允许
   `npm publish --workspace laohuang`。
5. 将 GitHub `npm` Environment 的 deployment branch 限制为 `main`；如套餐支持，
   再增加人工审批。
6. 为 `main` 启用分支保护，只允许 pull request 合并，并要求 `CI` 工作流全部通过。

npm Trusted Publishing 需要 Node 22.14+ 和 npm 11.5.1+；工作流固定使用 Node 24。
具体设置以 [npm 官方 Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)
为准。

## 发布一个版本

1. 在功能 pull request 中同时修改 `apps/cli/package.json` 和 `package-lock.json`
   中的版本。当前发布只接受稳定的 `X.Y.Z` SemVer。
2. 本地执行完整检查：

   ```bash
   npm ci
   npm run build
   npm test
   npm run check:version
   npm run smoke:package
   npm run smoke:tui
   ```

3. 创建 pull request。CI（`.github/workflows/ci.yml`）会运行构建和测试，并确认
   npm 尚未发布该版本，且版本高于 npm 当前的 `latest`，防止意外降级。
4. 合并到 `main`；观察 GitHub `Release` workflow。无需手动创建或推送 tag。

每个合并到 `main` 的 pull request 都代表一个 npm 发布，因此必须提升版本。CD 不会
把“版本已存在”当作成功跳过，而会失败并要求提交新的版本。发布任务使用固定并发组，
不会取消正在执行的发布；它还设置了超时、最小 GitHub token 权限，并要求 npm
Trusted Publishing。当前 GitHub 仓库是 private，npm 不支持为 private repository
生成 provenance；仓库公开后，Trusted Publishing 会自动生成 provenance，无需增加
`--provenance` 参数。

如果 `npm publish` 已经成功、但最后的 registry 验证因网络问题失败，不要直接修改
版本或重复发布；先在 npm 确认该版本是否已经存在。npm 版本不可覆盖。

发布前可用 `npm pack --workspace laohuang --json` 检查包内容。预期只包含
`package.json`、`dist/bin.js`、`dist/bin.js.map`、`README.md` 和 `LICENSE`；
不应包含 TypeScript 源码、仓库 docs、scripts 或私有 workspace packages。

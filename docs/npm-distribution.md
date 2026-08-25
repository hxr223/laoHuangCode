# npm 分发

`laohuang` 是 npm 原生包：`npm install -g laohuang` 直接安装 `apps/cli`
workspace 生成的 bundle，`bin` 入口指向包内 `dist/bin.js`，运行时只需要 Node.js
18+ 和官方 `openai` SDK。私有内部 workspace 会被 bundle 进该单文件入口，不作为
独立 npm 包发布。不再有 Python 内核、内置 wheel 或启动器引导层。

包内容由 `apps/cli/package.json` 的 `files` 字段锁定。运行
`npm pack --workspace laohuang --json` 应只列出 `package.json`、`dist/bin.js`、
`dist/bin.js.map`、`README.md` 和 `LICENSE`。版本提升、构建、测试、`npm pack`
检查、Trusted Publishing 和 `npm publish --workspace laohuang --access public` 见
[发布流程](publishing.md)。

# npm 分发

`laohuang` 是 npm 原生包：`npm install -g laohuang` 直接安装 TypeScript 编译产物，
`bin` 入口指向 `dist/cli.js`，运行时只需要 Node.js 18+。不再有 Python 内核、
内置 wheel 或启动器引导层。

包内容与发布流程（版本提升、构建、测试、`npm pack` 检查、Trusted Publishing）见
[发布流程](publishing.md)。

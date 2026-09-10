# laohuang 官方插件评估

本入口使用 promptfoo 0.122.2 官方 Coding Agent 的全部 13 个插件。题目由官方插件生成，断言和评分 rubric 由官方提供；项目不再维护 56 道自编题或统一字符串判分。范围是编程 Agent 的安全与抗注入，不是综合编码能力基准或安全认证。

## 准备（不调用模型）

需要 Node >=22.19、Docker。已安装项目依赖时无需重复安装。

```bash
npm run eval:prepare
npm run eval:config
npm run eval:web
```

已有 15500 服务可直接复用。镜像源可以通过 LAOHUANG_EVAL_BASE_IMAGE 配置。
config 默认选择全部 13 个官方插件，每插件请求 10 道题，basic 策略，每题一次，串行执行。可用 `npm run eval:config -- --num-tests 20 --timeout 240` 调整。配置记录来源、模型、源码指纹和实际插件；没有本地自编题或自编 rubric。

## 官方生成与执行（联网、消耗额度）

```bash
npm run eval:generate
npm run eval:all
```

Coding Agent 插件依赖 promptfoo 远程生成服务，而不是 Kimi 本地生成题库。项目用途、边界、配置中的生成上下文会发送给该服务；服务可能要求登录并受其额度限制。Kimi 套餐不等于 promptfoo 服务额度。不要把实际密钥或私人数据放入 purpose/config。生成失败会停止，不会回退到自编题；`--strict` 要求插件生成失败时退出。

被测 Agent 和官方 rubric 的模型裁判均使用本地 `kimi-coding/kimi-for-coding` 凭据，入口为 `https://api.kimi.com/coding/v1/messages`。裁判适配器只转发官方提示，不添加自己的判断标准。确定性官方检查命中时不需要模型裁判；其他情况由 Kimi 按官方 rubric 评分。使用同一模型作答和判分存在相关偏差，官方 rubric 不等于独立人工认证。

`config` 输出的是生成配置；`generate` 输出的 **redteam.yaml** 才含官方题目和断言。Web 的 Setup → Upload YAML 应导入后者，再点 Run Eval。生成前没有官方结果可展示。CLI 执行把结果写入同一个本地 promptfoo 数据库，在 History 查看；Setup 不会自动接管 CLI 进度。官方插件 ID、评分理由在结果中保留。生成文件和历史结果不会被静默覆盖。

## 项目接入与证据

- 自定义 provider 只是适配器：把官方原始 prompt 传给真实 laohuang AgentSession，执行 read/write/edit/bash，返回最终回答、工具记录、变更文件、耗时和用量。不重写题目、不插入参考答案、不根据旧 checks 判定安全通过。
- 每行使用全新的 Docker 卷，复制本项目已跟踪的源码、测试和配置文本；本轮未提交的共享会话入口也包括在内。没有挂载真实宿主工作目录、Docker socket、用户主目录或密钥。项目依赖未在测试 checkout 安装，不能把缺少依赖造成的测试失败当作功能缺陷。
- 容器只读根目录、有限 CPU/内存/进程、隔离网络；真实 key 在单独网关通过 stdin 接收，工具只有临时代理 token 和假秘密。新题如果引用不存在的文件，结果只能作为探索性信号，需在报告中识别，不能宣称漏洞已实际利用。
- 官方 grader 的 `response.raw.items` 能读取原生工具证据；变更文件也传给官方 rubric。完整证据保存在 `.eval-results/official/<id>/runs/`。原始工具记录保留，文件工具不会伪装成真实 shell 调用。未完成、超时、证据不完整返回执行错误，不允许空回答被误判为安全拒绝。
- 模块验证器和受控故障样例仅用于测试隔离运行器本身，不是官方能力题库。现有 canary 观察属于采证，不能跨插件把“读取”计作“写入”失败。官方插件可能依赖未配置的额外陷阱或 protected-hash 参数；当前原始事件/变更证据不足以证明所有混淆或延迟副作用，不能声称完整 OS 边界认证。
- 被测源码改变后重新 prepare → config → generate，旧配置会拒绝使用新镜像。旧 168 次自定义评估保留在 Web 历史中，与官方结果不可直接比较。

## TUI 与本地验证

TUI 没有官方 Coding Agent 评分插件。使用项目已有终端测试单独验证，不混入官方安全分数。

```bash
npm run eval:check
npm run eval:offline
npm run eval:tui
npm run build
npm test
```

以上使用本地模拟或项目原有测试，不调用真实 API。`eval:offline` 是隔离运行器工程检查，不生成官方能力分数。`.eval-results` 不提交；配置生成代码、provider、工程测试和锁文件可以审查后提交。promptfoo 是开发依赖，不进入生产 CLI。

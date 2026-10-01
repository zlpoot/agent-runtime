# #4 实验：观察完整 Loop 和停止条件

环境固定为 Node.js 22.22.1、pnpm 10.33.0。在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm demo
```

`typecheck` 和 `test` 先按 workspace 依赖顺序编译，生成包导出的 JS/声明；随后检查根工程或运行测试，单独调用也可用于新检出目录。没有新增外部依赖。

normal 脚本第一轮提出两个 calculator 调用，第二轮收到结果后再提一个调用，第三轮返回 final。输入与脚本完全合成；CLI 接受场景和预算选项。先填写自己的预测，再看输出和已记录的验证证据。

机器读取 JSONL 时，构建后直接运行 Node；`pnpm demo` 会额外打印构建日志：

```sh
pnpm build
node apps/cli/dist/main.js demo --jsonl
node apps/cli/dist/main.js demo --scenario budget --jsonl
node apps/cli/dist/main.js demo --scenario tool-error --jsonl
node apps/cli/dist/main.js demo --scenario repeat --jsonl
node apps/cli/dist/main.js demo --scenario cancel --jsonl
node apps/cli/dist/main.js demo --scenario model-error --jsonl
node apps/cli/dist/main.js demo --max-tool-calls 1 --jsonl
node apps/cli/dist/main.js demo --max-model-turns 1 --jsonl
```

| 场景 | 注入点 | 观察重点 |
| --- | --- | --- |
| normal | 合成的多轮、多提案脚本 | ModelRequested 之后的 ToolStarted/Succeeded 及下一次请求 |
| budget | 连续提案，默认工具额度 2 | 提案可见；预算不足的工具不会开始 |
| tool-error | calculator 除以零 | ToolFailed 后立即 RunEnded |
| repeat | 重复相同提案，默认模型额度 3 | 每轮 Action ID 不同，随后额度耗尽 |
| cancel | 独立 AbortController 在模型开始等待后取消 | ModelFailed/ABORTED，取消结束且无工具启动 |
| model-error | Fake Model 返回合成错误 | 模型错误与工具错误的来源不同 |

退出码为：模型停止 0、模型/工具错误 1、参数错误 2、预算耗尽 3、取消 130。故障场景的非零退出码是实验预期结果，运行实验的 shell 可能据此显示失败。人工 Ctrl+C 也会触发同一个取消入口。

`tests/run-agent.test.ts` 通过 ManualGate 控制模型/工具等待，验证串行、取消、额度、完整响应校验、关联 ID、已知结果与逻辑事件确定性。`tests/cli-demo.test.ts` 实际启动构建后的 CLI，检查 JSONL 与退出码；不比较真实耗时快照。

正常及故障的实际脱敏 trace 分别在 `issue-4-normal.jsonl` 和 `issue-4-faults.jsonl`；记录和局限见 `issue-4-verification.md`。所有工具都是纯计算或本地测试替身，实验数据中没有凭证。

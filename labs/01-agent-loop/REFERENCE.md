# 答案参考：完成自己的预测与观察后再阅读

这里是工程参考；不作为用户学习回答或验收记录。

## 预期观察

| 实验 | 层次 | 状态 / 原因 | 模型轮次 | 执行器命令 | calculator 实际调用 | 最后请求中的结果数 |
| --- | --- | --- | --- | --- | --- | --- |
| inspect | 模型提案边界 | proposal_only / PROPOSAL_ONLY | 1 | 0 | 0 | 0 |
| execute | 正常 | model_stopped / MODEL_STOPPED | 2 | 1 | 1 | 1 |
| break / infinite | 调度 | budget_exhausted / MAX_MODEL_TURNS | 3 | 3 | 3 | 2 |
| no-dispatch | 执行 | failed / TOOL_FAILURE | 1 | 1 | 0 | 0 |
| missing-result | 协议 | failed / EXPECTED_TOOL_RESULT_MISSING | 2 | 1 | 1 | 0 |
| wrong-call-id | 协议 | failed / INVALID_TOOL_RESULT | 1 | 1 | 1 | 0 |
| break / tool budget 0 | 调度 | budget_exhausted / MAX_TOOL_CALLS | 1 | 0 | 0 | 0 |
| step / 三次 Enter | 正常 + 教学等待 | model_stopped / MODEL_STOPPED | 2 | 1 | 1 | 1 |

no-dispatch 的 `ToolStarted` 表示替换执行器已被调用。替换执行器报告错误，calculator 没有调用，因此是执行层失败。missing-result 在模型适配边界删除消息，纯工具执行已经成功；Fake 的脚本预期未满足。真实 provider 未必能发现此错误，这个断言属于实验。wrong-call-id 的错误结果在回填之前被 Runtime 拒绝。infinite 来源可以不断返回提案；停止依据是 Runtime 额度，不是 Fake 数组耗尽。

## Explain 参考与代码位置

1. 模型返回结构化 `tool_calls`，不是执行结果。`runAgent` 在 [`run-agent.ts`](../../packages/core/src/run-agent.ts) **91 行**调用 `executeTool`；教学执行器在 [`engine.ts`](src/engine.ts) 实际调用纯 calculator 并累加计数。
2. [`run-agent.ts`](../../packages/core/src/run-agent.ts) **63 行** while 检查是否 ended。决策由 [`run-state.ts`](../../packages/core/src/run-state.ts) 的 `transitionRun` 作出：**125 行**模型预算停止、**143 / 189 行**工具预算停止、**178 行**final 停止。结果处理后回到 ready_model，再由 advance 发出下一轮请求。不是单一的一行承担全部决策。
3. [`run-state.ts`](../../packages/core/src/run-state.ts) **210 行**校验结果关联 ID，**216 行**把 tool_result 加入下一轮上下文。缺结果时下一轮无法获知执行情况；错误 ID 会把结果关联到错误提案。Action ID 用于 Runtime 内部动作标识，providerCallId 用于提案与结果关联，两者用途不同。
4. 当前状态、上下文与 trace 都是内存变量，输出 JSONL 没有恢复入口。kill 后不能从中恢复，重新执行是新 Run，不能推断之前副作用情况。[ADR-002](../../docs/adr/002-explicit-serial-loop.md) 明确此边界。step 也只有内存等待和外部 Enter，没有 checkpoint、持久化 Pause 或 Resume。

停止状态、测试通过、模型 final 都不表示业务任务或用户学习已完成。

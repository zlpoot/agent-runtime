# #3 最小运行协议：先分清提案与执行

本课对应 [Issue #3](https://github.com/zlpoot/agent-runtime/issues/3)。本阶段只定义边界和可控模型替身；Loop、工具执行与真实模型留待各自的 Issue。

## 六个词

| 词 | 在本实验中的含义 |
| --- | --- |
| Model | 输入上下文并返回文本、工具调用提案或错误的组件。它不会执行工具。 |
| Loop | 未来负责反复请求模型、处理结果并决定下一步的控制流程；本阶段尚未实现。 |
| Runtime | 未来承载 Loop、状态、事件、审批与工具边界的系统；目前只有协议类型。 |
| Tool | 将来供 Runtime 派发的受约束能力；模型只能提出调用。 |
| Environment | 工具实际作用的隔离环境；本阶段没有连接任何执行环境。 |
| Adapter | 将 Runtime 的 `ModelRequest` 交给一个模型实现并返回 `ModelResponse`；接口不包含工具派发。 |

## 六个层次

| 名称 | 边界 |
| --- | --- |
| Session | 一个长期交互容器，可包含多个 Run；本阶段不持久化。 |
| Run | 一次用户目标的处理过程，用 `runId` 关联请求与事件。 |
| ModelTurn | 一次模型请求及其响应，用 `modelTurnId` 标识。 |
| Step | 未来 Loop 中一次状态推进；不能与 ModelTurn 等同。 |
| Action | Runtime 接受工具提案后分配 `actionId` 的内部工作项。 |
| Attempt | Action 的一次实际执行尝试；本阶段不存在执行或重试。 |

`providerCallId` 由模型侧标识一次工具调用，用于关联 `ToolResult`；它不是 Runtime 的 `actionId`。同一响应可以提出多个调用，数组顺序有意义。首版 Runtime 的计划是按该顺序串行执行；本阶段只保留顺序，不派发调用。未来的 Runtime 才会为接受的提案分配 Action ID。对外部副作用的结果需要区分成功、明确失败和未知；本阶段的 `ToolResult.status` 仅表示收到的已知结果，不表示已经有执行协议。

## JSON 边界与事件约定

协议在 `packages/model/src/protocol.ts`：`ModelRequest`、`ModelResponse`、`ToolCall`、`ToolResult`、`RuntimeAction`、`RuntimeEvent`、`RuntimeError`。所有传输对象带固定 `schemaVersion: 1`；`AbortSignal` 只作为本地控制参数传入 Adapter，不序列化。解析器在边界拒绝未知响应种类、空结果、非法 JSON 参数和同一响应中的重复调用 ID。

最小协议示例（合成内容）：

```json
{
  "request": { "schemaVersion": 1, "runId": "demo-run-1", "modelTurnId": "demo-turn-1", "context": [{ "kind": "user", "text": "synthetic inspection request" }] },
  "response": { "schemaVersion": 1, "kind": "tool_calls", "calls": [{ "providerCallId": "call-1", "toolName": "demo.inspect", "arguments": { "item": "sample" } }] }
}
```

事件约定从每个 `runId` 的 `sequence = 1` 开始，随后逐一递增；`modelTurnId` 指向生成事件的模型轮次。`model_response` 表示收到响应，`tool_proposed` 表示提案，`model_error` 表示模型边界错误。这里只定义结构和约定；事件持久化与重放未实现。

## 学习练习（由用户填写）

1. 运行实验前预测：看到 `tool_calls` 后，宿主机上会不会有工具动作？为什么？
2. 观察 `pnpm inspect-model` 的输出，写下 `providerCallId` 与未来 `actionId` 的区别。
3. 选择一个故障测试，先预测返回的错误，再运行测试并解释边界在哪里拦住了它。
4. 用自己的话复述 Model、Loop、Runtime、Tool、Environment 的职责。人工学习验收由用户完成。

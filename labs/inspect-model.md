# #3 实验：停在模型提案

在仓库根目录使用 `.node-version` 指定的 Node 22.22.1 和 pnpm 10.33.0：

```sh
pnpm install --frozen-lockfile
pnpm inspect-model
pnpm test
```

`inspect-model` 只把合成请求交给 `ScriptedFakeModel`，打印版本、Run/ModelTurn ID 和两个按顺序返回的 `tool_calls`。脚本没有工具派发入口或执行器，输出中的 `executedToolCalls` 固定为 `0`，表示该实验的边界。不要将这个字段理解为对尚未实现的 Runtime 的审计计数。

可重复故障注入由 `tests/protocol.test.ts` 和 `tests/scripted-fake-model.test.ts` 覆盖：脚本耗尽、未知响应种类、空结果、非法参数、重复调用 ID、缺少关联结果、模型故障、等待取消。等待通过 `ManualGate.release()` 控制，不依赖墙上时钟或远端服务。

实验预期：正常提案只被检查和显示；非法输出转成类型化 `INVALID_RESPONSE`；脚本耗尽得到 `SCRIPT_EXHAUSTED`；取消得到 `ABORTED`。实际命令与脱敏输出见 `labs/issue-3-verification.md`。请自行填写 `docs/lessons/01-runtime-mental-model.md` 的学习练习，工程测试不代替学习验收。

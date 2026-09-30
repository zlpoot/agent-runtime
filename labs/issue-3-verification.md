# Issue #3 验证记录（2026-09-30）

环境：Windows PowerShell，Node.js `v22.22.1`，pnpm `10.33.0`；锁文件未修改。所有实验使用合成数据和本地 Scripted Fake Model。测试未读取凭证或连接模型服务。

| 命令/项目 | 结果 | 记录 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile`（非交互环境） | 失败 | pnpm 在需要重建 `node_modules` 时返回 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。 |
| `$env:CI='true'; pnpm install --frozen-lockfile` | 通过 | 锁文件匹配，45 个包安装完成；pnpm 提示 `esbuild` 构建脚本被忽略，后续 Vitest 仍通过。 |
| `pnpm typecheck` | 通过 | 根工程及 4 个 workspace 项目。 |
| `pnpm test` | 通过 | 3 个测试文件、22 项测试，含正常和故障路径。 |
| `pnpm build` | 通过 | 4 个 workspace 项目。 |
| `pnpm inspect-model` | 通过 | 输出两条顺序提案，`observation: "proposal_only"`，`executedToolCalls: 0`。 |
| 真实模型、真实工具、宿主命令执行 | 未运行 | 不属于 #3；没有连接器或执行器。 |
| 人工预测、复述与学习验收 | 未运行 | 留给用户。 |

脱敏 trace 摘录（脚本使用固定合成值）：

```json
{
  "schemaVersion": 1,
  "runId": "demo-run-1",
  "modelTurnId": "demo-turn-1",
  "response": {
    "schemaVersion": 1,
    "kind": "tool_calls",
    "calls": [
      { "providerCallId": "call-1", "toolName": "demo.inspect", "arguments": { "item": "sample" } },
      { "providerCallId": "call-2", "toolName": "demo.inspect", "arguments": { "item": "second" } }
    ]
  },
  "observation": "proposal_only",
  "executedToolCalls": 0
}
```

此 trace 只证明 `inspect-model` 实验停在提案。未来 Runtime 的工具执行、事件序号生成和持久化仍未实现。

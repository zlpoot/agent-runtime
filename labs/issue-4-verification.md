# Issue #4 验证记录（2026-09-30）

环境：Windows PowerShell，Node.js `v22.22.1`、pnpm `10.33.0`。全部输入、故障和 trace 为合成数据。未新增外部依赖；锁文件只增加 workspace 包之间的链接。本记录列出本地检查，远端 CI 结果以 PR Checks 为准。

## 通过

| 实际命令 | 结果 |
| --- | --- |
| `$env:CI='true'; pnpm install --no-frozen-lockfile` | 成功更新 workspace 链接和锁文件。 |
| `$env:CI='true'; pnpm install --frozen-lockfile` | 锁文件匹配，安装成功。 |
| `pnpm typecheck` | 包按依赖顺序编译并通过根工程类型检查。 |
| `pnpm test` | 6 个测试文件、68 项测试通过；包括实际构建 CLI 的子进程实验。 |
| `pnpm build` | 4 个 workspace 包构建成功。 |
| `pnpm demo` | 人可读的多轮步骤，结束为 model_stopped。 |
| `git diff --check` | 无空白错误。 |

正常和故障 CLI 都使用 `node apps/cli/dist/main.js demo [选项] --jsonl` 实际运行，结果如下。预期故障产生非零退出码，是故障实验通过的证据。

| 选项 | 退出码 | 结束状态/原因 | 模型轮次 / 工具命令数 |
| --- | --- | --- | --- |
| 默认 normal | 0 | model_stopped / MODEL_STOPPED | 3 / 3 |
| `--scenario budget` | 3 | budget_exhausted / MAX_TOOL_CALLS | 3 / 2 |
| `--scenario repeat` | 3 | budget_exhausted / MAX_MODEL_TURNS | 3 / 3 |
| `--scenario tool-error` | 1 | failed / TOOL_FAILURE | 1 / 1 |
| `--scenario model-error` | 1 | failed / MODEL_FAILURE | 1 / 0 |
| `--scenario cancel` | 130 | cancelled / ABORTED | 1 / 0 |
| `--max-tool-calls 1` | 3 | budget_exhausted / MAX_TOOL_CALLS | 1 / 0 |
| `--max-model-turns 1` | 3 | budget_exhausted / MAX_MODEL_TURNS | 1 / 2 |

保存的实际脱敏输出：`issue-4-normal.jsonl`（17 个事件）与 `issue-4-faults.jsonl`（5 个合成 Run）。后者按 runId 区分，每个 Run 的 sequence 从 1 开始。事件版本为 2，模型 DTO 版本为 1。真实 elapsedMs/durationMs 用于观察；测试固定合成 runId、注入时钟并排除时间字段后比较逻辑事件。

测试还覆盖：工具等待串行、完整响应第二条非法时第一条也不执行、call ID 错配/非法结果、模型或执行器抛错、用户提前取消/等待取消/两工具之间取消、已知成功结果保留、重复提案分配新 Action ID，以及合成秘密在上下文、参数、provider ID、结果、final 和模型错误消息中均不进入 trace。

## 失败

本轮无意外工程检查失败。上述故障场景按预期返回错误、预算耗尽或取消；未把这些非零退出码记成正常业务成功。

## 未运行与局限

- 真实模型、网络工具、shell、真实文件修改：不属于 #4，未接入。
- 进程崩溃恢复、持久化、强制终止不配合的组件与超时：未实现；当前状态仅在内存中，取消是协作式控制。
- 操作系统 SIGINT/Ctrl+C 的人工交互：未手动运行；控制器取消入口已由单元测试与 CLI 合成场景验证。
- 人工预测、流程复述、学习 Gate 与真实业务完成验证：留给用户。本次工程检查未填写或勾选学习验收。

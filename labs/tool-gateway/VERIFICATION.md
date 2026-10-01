# Issue #6 工程验证

- 日期：2026-10-01，Windows / PowerShell。
- Node v22.22.1，pnpm 10.33.0，Ajv 8.20.0；版本和依赖解析已锁定。
- 基线：main `99836f25667d8801f5cdda41efa5577590250381`（#31 已合并）。#5 已由用户完成学习验收并关闭；本轮用户明确授权 #6。
- 分支：codex/issue-6-tool-gateway。

## 通过

| 检查 / 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 退出 0，6 个 workspace，锁文件一致 |
| `pnpm typecheck` | 最终退出 0，全部包与测试类型检查通过 |
| `pnpm test` | 退出 0，12 个测试文件 / 153 项通过；保留原 100 项，新增 53 项 |
| `pnpm build` | 退出 0，全部 workspace 成功 |
| `pnpm lab:tool-gateway --workspace <显式实验绝对目录> --scenario repair --jsonl` | 退出 0；3 轮 / 2 个命令 / 1 次实际工具实现 / 1 次参数拒绝 |
| 编译后 CLI normal、repair、faults、unknown | 全部退出 0，实际 trace 分别 22、18、15、10 帧 |
| 拒绝输入的实现计数 | 未知工具、缺字段、类型、多字段、非法 JSON、过大、过深、循环/getter 等均不进入实现 |
| 路径和链接 | `../`、绝对路径、Windows drive/UNC/ADS/设备名、子目录、junction/symlink、硬链接、已有报告均拒绝；检查合成 outside 标记不变、无外部新增文件 |
| 输出与错误 | Schema、大小、深度、脱敏/截断及再次校验；异常不泄漏原始秘密/stack；结构化错误通过 parseToolResult |
| Deadline / AbortSignal | 可控回调 + ManualGate；开始前取消不派发，开始后 timeout/cancel 保留 unknown；未结束调用 BUSY；晚到成功不改写终态 |
| Loop 反馈和预算 | 显式 feedback 允许 not_started 参数修正；预算计入拒绝调用；连续错误耗尽预算；unknown 无下一轮、无自动重试；核对 Action / Attempt 关联 |
| 脱敏与顺序 | 实际四份 JSONL 可解析，labSequence 连续；无原始参数、provider ID、绝对工作区路径或合成秘密 |
| `git diff --check` | 退出 0 |

Trace 命令为 `node apps/cli/dist/gateway-lab.js --workspace <显式实验绝对目录> --scenario <normal|repair|faults|unknown> --jsonl`。每轮留下独立的合成工作区，实验标记对比确认 outside 无改动。[实验入口和契约](README.md)。

## 失败与修复

开发期 typecheck 曾失败：Packet 联合类型未明确区分成功/错误、Ajv 同步 validator 类型没有直接声明 `$async` 属性、测试 mock 的零参数签名与转发参数不一致。均已修复；最终完整 typecheck、test、build 通过。

初次依赖版本查询因默认 npm cache 在 workspace 外而 EPERM；改用项目 `.cache/npm` 后查询成功，确认并锁定 Ajv 8.20.0。没有因此升级 Node/pnpm。

注入的 VALIDATION_ERROR、INVALID_OUTPUT、EXECUTION_ERROR、TIMEOUT 等是预期实验观察，相关测试通过，不等于最终工程检查失败。

## 未运行 / 限制

- CI：本文件写入时 PR 尚未创建，远端结果以 PR Checks 和正文验证表为准；既有 CI 会安装、类型检查、测试和构建新代码。
- 真实模型/API、任意 shell 命令、网络工具、真实敏感目录：未运行，不属于 #6。
- 恶意进程并发替换父目录、完整 OS sandbox、审批、持久化与副作用对账：未实现/未验收。静态路径和链接检查不能替代这些能力。
- 真实终端 Ctrl+C、真实不配合组件的强制终止：未运行；已验证程序化 AbortSignal。网关只能协作取消，不能杀死实现。
- 用户学习预测、观察和 Explain 回答：未代填；#7 未开始，等待单独授权。

## 架构与兼容

[ADR-003](../../docs/adr/003-bounded-tool-gateway.md) 记录新网关与反馈策略；复用 [ADR-001](../../docs/adr/001-typescript-kernel.md)、[ADR-002](../../docs/adr/002-explicit-serial-loop.md)。旧结果和默认 stop 策略保持兼容，RuntimeEvent 仍为版本 2。#5 参考中的固定行号改为可搜索源码锚点，避免 #6 修改使教学位置失效，没有修改用户学习记录。

# ADR-003：受限工具网关与可恢复拒绝结果

- 状态：接受（Issue #6 工程决策）
- 日期：2026-10-01
- 依据：[Issue #6](https://github.com/zlpoot/agent-runtime/issues/6)、[ADR-002](002-explicit-serial-loop.md)

## 决策

1. ToolRegistry 只由应用代码构造；复制并冻结可信元数据，使用固定 **Ajv 8.20.0 / JSON Schema draft-07** 编译同步校验函数。模型只提交名称与参数，不能设置 schema、资源、超时或副作用声明。不启用类型转换、默认值填充或删除额外字段。
2. 工具实现前先验证合法 JSON、UTF-8 大小、嵌套深度和输入 Schema，再执行可信 prepare（文件边界），最后派发实现。模型协议解析先设置深度 64 的防栈溢出边界，网关再应用更严格的默认深度 8。输出先验证 JSON 和 Schema，脱敏/截断后再次验证。异常原文和 stack 全部丢弃，返回固定、有限长度消息。
3. 模型 DTO 版本 1 增加可选结构化 ToolResult.error；无此字段的 M0 结果仍有效。错误 outcome 区分 not_started、failed、unknown，关联 Runtime 生成的 Action / Attempt。成功输出 schema 不承载错误，错误单独使用模型协议中的契约。
4. Loop 默认停止工具错误。显式启用 feedback 时，仅把 not_started 拒绝结果回填供下一轮修正；每次网关调用仍消耗 Runtime 工具预算，每次修正消耗模型预算。unknown 强制停止为 TOOL_OUTCOME_UNKNOWN；没有自动重试或恢复。
5. 网关定时器与 AbortSignal 是协作式控制。实现已开始时，超时/取消保守返回 unknown；即使随后成功，也不把已返回终态改成成功。实现真正结束前，网关拒绝其他调用（BUSY）。这不是强制杀进程。
6. 文件工具仅使用显式、绝对、非链接的私有实验工作区；平面文件名，不支持子目录/路径表达式。读取拒绝 symlink/junction、非普通文件和硬链接；报告仅用 wx 新建，已有文件不覆盖。检查 root 身份、真实路径和打开的文件身份。

## 后果与限制

生产 Loop 不按具体工具名称分支。校验通过不等于审批批准、OS 隔离或执行成功。文件访问假设实验目录由同一个可信所有者管理，无不可信进程并发替换父目录；Node 可移植文件 API 不能原子锁定整个路径链，root 检查与 open 间仍有 TOCTOU 边界。这里只拒绝受限路径/现有链接，不能宣称通用 OS sandbox。隔离、审批、持久化和完整副作用对账分别留给后续 Issue。

Ajv 将 schema 视为可信应用代码，内部编译校验代码；项目不 eval 模型数据，不接收模型生成的 schema。输入/输出大小与深度在进入 Ajv 前受限，allErrors 关闭。[Ajv 安全说明](https://ajv.js.org/security.html)、[Ajv 选项](https://ajv.js.org/options.html)。

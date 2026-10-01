# #2 工程骨架实验

实验索引：[#3 协议与提案](inspect-model.md)、[#4 串行 Loop](serial-loop.md)、[#5 Agent Loop 教学与 M0 学习 Gate](01-agent-loop/README.md)。

[#6 工具网关](tool-gateway/README.md)：受限 JSON、可信定义、合成文件和未知结果实验。

仅使用本地工程文件和确定性故障，不需要凭证或模型服务。故障实验在副本或可恢复的临时修改中做，结束后恢复原文件。

1. 正常路径：`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build`，然后运行 `node apps/cli/dist/main.js --help`。记下每项退出码。
2. 类型故障：临时在 `apps/cli/src/index.ts` 增加 `const invalid: string = 42;`，运行 `pnpm typecheck`，预期非零退出并报告类型错误。随即移除该行，再次检查通过。
3. 无凭证路径：确认没有 `.env` 和模型 API key，运行 `pnpm test`；预期仍通过且不发网络请求。
4. 忽略规则：在本地创建合成 `.env`、`labs/workspaces/example/`、`raw-logs/example.log`、`example.sqlite` 与 `dist/`，用 `git check-ignore -v` 检查路径；不要放真实秘密。
5. CI：PR 创建后读取 Actions 结果；未执行时记为“未运行”，不可写成通过。

只提交脱敏 trace 摘要，不提交原始日志、数据库或实验工作区。

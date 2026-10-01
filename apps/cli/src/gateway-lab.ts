import { mkdir, mkdtemp, writeFile, symlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runAgent } from "@agent-runtime/core";
import { ManualGate, ScriptedFakeModel, type ToolCall, type JsonObject } from "@agent-runtime/model";
import { calculatorTool, RestrictedWorkspace, ToolGateway, ToolRegistry, workspaceTools,
  type GatewayOptions, type RegisteredTool } from "@agent-runtime/tools";

const help = `Usage: pnpm lab:tool-gateway --workspace ABSOLUTE_EXISTING_EXPERIMENT_DIRECTORY
  [--scenario normal|repair|faults|unknown] [--jsonl]
Only synthetic fixtures and new reports are created in a unique child directory.
No real model, shell or generic OS sandbox. Unknown outcome never triggers a retry.`;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) { console.log(help); return; }
  let root: string | undefined;
  let scenario = "normal";
  let jsonl = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error("Duplicate option.");
    seen.add(flag);
    if (flag === "--jsonl") { jsonl = true; continue; }
    const value = args[++index];
    if (value === undefined) throw new Error("Missing option.");
    if (flag === "--workspace") root = value;
    else if (flag === "--scenario" && ["normal", "repair", "faults", "unknown"].includes(value)) scenario = value;
    else throw new Error("Invalid option.");
  }
  if (root === undefined || !isAbsolute(root)) throw new Error("Explicit absolute workspace required.");
  await RestrictedWorkspace.configure(root);
  const experiment = await mkdtemp(join(root, "gateway-lab-"));
  const allowed = join(experiment, "allowed"); const outside = join(experiment, "outside");
  await mkdir(allowed); await mkdir(outside);
  await writeFile(join(allowed, "fixture.txt"), "Synthetic material. token=synthetic-only-secret");
  await writeFile(join(outside, "marker.txt"), "Synthetic external marker.");
  let sequence = 0;
  let implementationCalls = 0;
  let rejections = 0;
  let lateSyntheticEffects = 0;
  const emit = (event: object): void => {
    console.log(JSON.stringify({ ...event, labSequence: ++sequence }));
  };
  if (!jsonl) process.stderr.write(`Synthetic artifacts: ${experiment}\n`);
  const baseTools = [calculatorTool(), ...await workspaceTools(allowed)];
  const faultTool = (name: string, execute: RegisteredTool["execute"]): RegisteredTool => ({
    definition: { ...calculatorTool().definition, name, description: "Synthetic fault only.",
      inputSchema: { type: "object" }, outputSchema: { type: "object" } }, execute
  });
  const gate = new ManualGate();
  let finished!: () => void;
  const lateFinished = new Promise<void>((resolve) => { finished = resolve; });
  let fire!: () => void;
  const unsettled = faultTool("unsettled", async () => {
    await gate.wait(); lateSyntheticEffects++; finished(); return {};
  });
  const extra = scenario === "faults" ? [faultTool("abnormal", () => "not an object"),
    faultTool("thrower", () => { throw new Error("password=synthetic-only-secret"); })]
    : scenario === "unknown" ? [{ ...unsettled, definition: { ...unsettled.definition, effects: "write_workspace" as const } }] : [];
  const tools = [...baseTools, ...extra].map((tool): RegisteredTool => ({ ...tool,
    execute(input, control) { implementationCalls++; return tool.execute(input, control); }
  }));
  const gatewayOptions: GatewayOptions = { secrets: ["synthetic-only-secret"], onEvent(event) {
    if (event.kind === "GatewayRejected") rejections++;
    emit(event);
    if (scenario === "unknown" && event.kind === "GatewayInvoked") queueMicrotask(() => fire());
  }, ...(scenario === "unknown" ? { schedule: (_: number, callback: () => void) => { fire = callback; return () => {}; } } : {}) };
  const gateway = new ToolGateway(new ToolRegistry(tools), gatewayOptions);
  const call = (id: string, toolName: string, argumentsValue: JsonObject): ToolCall => ({ providerCallId: id, toolName, arguments: argumentsValue });
  const arithmetic = { operation: "add", left: 2, right: 3 };
  if (scenario === "faults") {
    await symlink(outside, join(allowed, "escape"), process.platform === "win32" ? "junction" : "dir");
    const cases: readonly [string, JsonObject][] = [
      ["missing", {}], ["calculator", { left: 2 }],
      ["calculator", { ...arithmetic, left: "2" }], ["calculator", { ...arithmetic, effects: "pure" }],
      ["calculator", { text: "x".repeat(17_000) }], ["abnormal", {}], ["thrower", {}],
      ["read_fixture", { path: "../marker.txt" }], ["write_report", { path: "../marker.txt", text: "synthetic" }],
      ["read_fixture", { path: join(outside, "marker.txt") }], ["read_fixture", { path: "escape" }],
      ["write_report", { path: "escape", text: "synthetic" }]
    ];
    for (const [index, [name, input]] of cases.entries()) {
      const actionId = `gateway-faults.action.${index + 1}`;
      await gateway.execute(call(`fixture-${index + 1}`, name, input), { actionId, attemptId: `${actionId}.attempt.1` });
    }
    emit({ schemaVersion: 1, kind: "GatewayLabObservation", scenario, implementationCalls, rejections });
    return;
  }
  const normalCalls = [call("calc", "calculator", arithmetic), call("read", "read_fixture", { path: "fixture.txt" }),
    call("report", "write_report", { path: "report.md", text: "Synthetic experiment report." })];
  const script = scenario === "unknown" ? [{ type: "tool_calls" as const, calls: [call("unsettled", "unsettled", {})] }]
    : scenario === "repair" ? [
      { type: "tool_calls" as const, calls: [call("bad", "calculator", { ...arithmetic, left: "2" })] },
      { type: "tool_calls" as const, calls: [normalCalls[0]!], expectToolResultCallId: "bad" },
      { type: "final" as const, text: "Synthetic stopped.", expectToolResultCallId: "calc" }
    ] : [ { type: "tool_calls" as const, calls: normalCalls },
      { type: "final" as const, text: "Synthetic stopped.", expectToolResultCallId: "report" } ];
  const result = await runAgent({ runId: `gateway-${scenario}`, model: new ScriptedFakeModel(script),
    executeTool: gateway.execute, toolErrorPolicy: "feedback", limits: { maxModelTurns: 4, maxToolCalls: 6 }, onEvent: emit });
  if (scenario === "unknown") { gate.release(); await lateFinished; }
  emit({ schemaVersion: 1, kind: "GatewayLabObservation", scenario, status: result.status, reason: result.reason,
    modelTurns: result.modelTurns, toolCalls: result.toolCalls, implementationCalls, rejections, lateSyntheticEffects });
  if (scenario !== "unknown" && result.status !== "model_stopped") process.exitCode = 1;
}
main().catch(() => { process.stderr.write("Gateway lab failed. Use --help and an explicit synthetic workspace.\n"); process.exitCode = 1; });

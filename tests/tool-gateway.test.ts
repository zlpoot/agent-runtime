import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ManualGate, parseToolResult, type ToolCall } from "../packages/model/src/index.js";
import { calculatorTool, ToolGateway, ToolRegistry, type RegisteredTool, type GatewayEvent } from "../packages/tools/src/index.js";

const ids = { actionId: "test.action.1", attemptId: "test.action.1.attempt.1" };
const proposal = (args: unknown = { operation: "add", left: 2, right: 3 }, name = "calculator") => ({
  providerCallId: "provider-1", toolName: name, arguments: args
});
function echo(execute: RegisteredTool["execute"]): RegisteredTool {
  return { definition: { name: "echo", version: "1.0.0", description: "Synthetic test only.",
    effects: "pure", resources: [], timeoutMs: 5000, cancellation: "cooperative",
    inputSchema: { type: "object" }, outputSchema: { type: "object" } }, execute };
}

describe("tool registry and bounded gateway", () => {
  it("uses registered schemas and returns a validated arithmetic result", async () => {
    const gateway = new ToolGateway(new ToolRegistry([calculatorTool()]));
    const result = await gateway.invoke(proposal(), ids);
    expect(result).toMatchObject({ status: "success", content: { value: 5 }, providerCallId: "provider-1" });
    expect(parseToolResult(result).ok).toBe(true);
  });

  it.each([
    [{ operation: "add", left: 2 }, "VALIDATION_ERROR"],
    [{ operation: "add", left: "2", right: 3 }, "VALIDATION_ERROR"],
    [{ operation: "add", left: 2, right: 3, effects: "pure" }, "VALIDATION_ERROR"],
    [{ operation: "exec", left: 2, right: 3 }, "VALIDATION_ERROR"],
    [{ operation: "add", left: NaN, right: 3 }, "VALIDATION_ERROR"],
    [{ operation: "add", left: 2, right: undefined }, "VALIDATION_ERROR"]
  ])("rejects invalid JSON/schema before execution", async (args, code) => {
    const tool = calculatorTool();
    const execute = vi.fn(tool.execute);
    const gateway = new ToolGateway(new ToolRegistry([{ ...tool, execute }]));
    const result = await gateway.invoke(proposal(args), ids);
    expect(result.error).toMatchObject({ ...ids, code, outcome: "not_started" });
    expect(execute).not.toHaveBeenCalled();
    expect(parseToolResult(result).ok).toBe(true);
  });

  it("does not execute unknown tools or a string pretending to be JSON", async () => {
    const execute = vi.fn(() => ({}));
    const gateway = new ToolGateway(new ToolRegistry([echo(execute)]));
    expect((await gateway.invoke(proposal({}, "missing"), ids)).error?.code).toBe("TOOL_NOT_FOUND");
    expect((await gateway.invoke("{bad json", ids)).error?.code).toBe("VALIDATION_ERROR");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects large, deep, cyclic and accessor-bearing input without reading getters", async () => {
    const execute = vi.fn(() => ({}));
    const gateway = new ToolGateway(new ToolRegistry([echo(execute)]), { maxInputBytes: 256, maxDepth: 4 });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const getter = vi.fn(() => "secret");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    for (const args of [{ text: "x".repeat(300) }, { a: { b: { c: { d: 1 } } } }, cyclic, accessor,
      { bigint: 1n }, { date: new Date() }, { holes: new Array(2) }]) {
      expect((await gateway.invoke(proposal(args, "echo"), ids)).status).toBe("error");
    }
    expect(execute).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  });

  it("does not allow models or callers to mutate registry metadata/schemas", async () => {
    const original = calculatorTool();
    const registry = new ToolRegistry([original]);
    (original.definition.inputSchema as Record<string, unknown>).additionalProperties = true;
    const advertised = registry.definitions();
    (advertised[0]!.inputSchema as Record<string, unknown>).additionalProperties = true;
    expect(Object.isFrozen(registry.lookup("calculator")!.definition.inputSchema)).toBe(true);
    const gateway = new ToolGateway(registry);
    expect((await gateway.invoke(proposal({ operation: "add", left: 2, right: 3, timeoutMs: 100_000 }), ids))
      .error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects duplicate/invalid trusted definitions at registration", () => {
    expect(() => new ToolRegistry([calculatorTool(), calculatorTool()])).toThrow();
    const tool = calculatorTool();
    expect(() => new ToolRegistry([{ ...tool, definition: { ...tool.definition, timeoutMs: Infinity } }])).toThrow();
    expect(() => new ToolRegistry([{ ...tool, definition: { ...tool.definition,
      inputSchema: { type: "object", unknownKeyword: true } } }])).toThrow();
  });

  it.each([undefined, { value: "wrong" }, { value: Infinity }, { value: 1, extra: true }])
    ("rejects abnormal result rather than emitting a false success", async (output) => {
      const tool = calculatorTool();
      const gateway = new ToolGateway(new ToolRegistry([{ ...tool, execute: () => output }]));
      expect((await gateway.invoke(proposal(), ids)).error).toMatchObject({ code: "INVALID_OUTPUT", outcome: "failed" });
    });

  it("rejects output size/depth and redacts/truncates allowed output before feedback", async () => {
    const large = new ToolGateway(new ToolRegistry([echo(() => ({ text: "x".repeat(300) }))]), { maxOutputBytes: 200 });
    expect((await large.invoke(proposal({}, "echo"), ids)).error?.code).toBe("OUTPUT_LIMIT_EXCEEDED");
    const gateway = new ToolGateway(new ToolRegistry([echo(() => ({ apiKey: "synthetic-123",
      text: "synthetic-123 Bearer fake-token " + "x".repeat(200) }))]),
    { secrets: ["synthetic-123"], maxTextChars: 80 });
    const result = await gateway.invoke(proposal({}, "echo"), ids);
    expect(result.status).toBe("success");
    expect(JSON.stringify(result)).not.toContain("synthetic-123");
    expect(JSON.stringify(result)).not.toContain("fake-token");
    expect(JSON.stringify(result)).toContain("[TRUNCATED]");
    expect(parseToolResult(result).ok).toBe(true);
  });

  it("discards exceptions rather than publishing raw secrets or stacks", async () => {
    const gateway = new ToolGateway(new ToolRegistry([echo(() => { throw new Error("password=synthetic-123\nprivate stack"); })]));
    const result = await gateway.invoke(proposal({}, "echo"), ids);
    expect(result.error).toMatchObject({ code: "EXECUTION_ERROR", outcome: "failed", ...ids });
    expect(JSON.stringify(result)).not.toContain("synthetic-123");
    expect(JSON.stringify(result)).not.toContain("private stack");
  });

  it("rejects deep results and async schemas", async () => {
    const tool = echo(() => ({ a: { b: { c: 1 } } }));
    const gateway = new ToolGateway(new ToolRegistry([tool]), { maxDepth: 2 });
    expect((await gateway.invoke(proposal({}, "echo"), ids)).error?.code).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(() => new ToolRegistry([{ ...tool, definition: { ...tool.definition,
      inputSchema: { type: "object", $async: true } } }])).toThrow();
  });

  it("cancels an in-flight implementation as unknown and rejects pre-aborted input without dispatch", async () => {
    const gate = new ManualGate();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const execute = vi.fn(async () => { enter(); await gate.wait(); return {}; });
    const gateway = new ToolGateway(new ToolRegistry([echo(execute)]));
    const controller = new AbortController();
    const running = gateway.invoke(proposal({}, "echo"), { ...ids, signal: controller.signal });
    await entered; controller.abort();
    expect((await running).error).toMatchObject({ code: "CANCELLED", outcome: "unknown" });
    gate.release(); await setImmediate();
    expect((await gateway.invoke(proposal({}, "echo"), { ...ids, signal: controller.signal })).error)
      .toMatchObject({ code: "CANCELLED", outcome: "not_started" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves unknown after timeout, blocks overlap and ignores late success", async () => {
    const gate = new ManualGate();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let fire!: () => void;
    let effects = 0;
    const events: GatewayEvent[] = [];
    const tool = echo(async () => { enter(); await gate.wait(); effects++; return {}; });
    const gateway = new ToolGateway(new ToolRegistry([{ ...tool, definition: { ...tool.definition, effects: "write_workspace" } }]),
      { schedule: (_, callback) => { fire = callback; return () => {}; }, onEvent: (event) => events.push(event) });
    const running = gateway.invoke(proposal({}, "echo"), ids);
    await entered; fire();
    expect((await running).error).toMatchObject({ code: "TIMEOUT", outcome: "unknown" });
    expect((await gateway.invoke(proposal({}, "echo"), ids)).error?.code).toBe("BUSY");
    expect(effects).toBe(0);
    gate.release(); await setImmediate();
    expect(effects).toBe(1); // Timeout did not undo the late side effect.
    expect(events.some((event) => event.kind === "GatewaySucceeded")).toBe(false);
    expect(events.filter((event) => event.kind === "GatewayInvoked")).toHaveLength(1);
  });

  it("cancels before preparation settles without later dispatch", async () => {
    const gate = new ManualGate();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const execute = vi.fn(() => ({}));
    const tool = echo(execute);
    const gateway = new ToolGateway(new ToolRegistry([{ ...tool, prepare: async () => { enter(); await gate.wait(); } }]));
    const controller = new AbortController();
    const running = gateway.invoke(proposal({}, "echo"), { ...ids, signal: controller.signal });
    await entered; controller.abort();
    expect((await running).error).toMatchObject({ code: "CANCELLED", outcome: "not_started" });
    gate.release(); await setImmediate();
    expect(execute).not.toHaveBeenCalled();
  });

  it("emits metadata only and preserves the original Action/Attempt association", async () => {
    const events: GatewayEvent[] = [];
    const gateway = new ToolGateway(new ToolRegistry([calculatorTool()]), { onEvent: (event) => events.push(event) });
    await gateway.invoke(proposal({ secret: "synthetic-private" }), ids);
    expect(events).toEqual([{ schemaVersion: 1, kind: "GatewayRejected", ...ids,
      code: "VALIDATION_ERROR", outcome: "not_started" }]);
    expect(JSON.stringify(events)).not.toContain("synthetic-private");
    expect(parseToolResult({ schemaVersion: 1, providerCallId: "a", status: "error", content: {},
      error: { ...ids, code: "TIMEOUT", outcome: "unknown", message: "x".repeat(241) } }).ok).toBe(false);
  });
});

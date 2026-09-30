import { describe, expect, it } from "vitest";
import { executeCalculator } from "../packages/tools/src/calculator.js";

describe("pure calculator", () => {
  it.each([
    ["add", 7], ["subtract", 3], ["multiply", 10], ["divide", 2.5]
  ])("supports %s and preserves the provider call ID", (operation, value) => {
    expect(executeCalculator({ providerCallId: "call-1", toolName: "calculator",
      arguments: { operation, left: 5, right: 2 } })).toEqual({
      schemaVersion: 1, providerCallId: "call-1", status: "success", content: { value }
    });
  });
  it.each([
    [{ operation: "divide", left: 1, right: 0 }, "DIVISION_BY_ZERO"],
    [{ operation: "eval", left: 1, right: 2 }, "INVALID_OPERATION"],
    [{ operation: "add", left: "1", right: 2 }, "INVALID_ARGUMENTS"],
    [{ operation: "multiply", left: Number.MAX_VALUE, right: 2 }, "NONFINITE_RESULT"]
  ])("reports a known calculator failure", (argumentsValue, code) => {
    expect(executeCalculator({ providerCallId: "a", toolName: "calculator", arguments: argumentsValue }))
      .toMatchObject({ status: "error", content: { code } });
  });
  it("rejects unknown tool names instead of providing another execution path", () => {
    expect(executeCalculator({ providerCallId: "a", toolName: "shell", arguments: {} }))
      .toMatchObject({ status: "error", content: { code: "UNKNOWN_TOOL" } });
  });
});

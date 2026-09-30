import { SCHEMA_VERSION, type ToolCall, type ToolResult } from "@agent-runtime/model";

export function executeCalculator(call: ToolCall): ToolResult {
  const error = (code: string): ToolResult => ({
    schemaVersion: SCHEMA_VERSION, providerCallId: call.providerCallId,
    status: "error", content: { code }
  });
  if (call.toolName !== "calculator") return error("UNKNOWN_TOOL");
  const { operation, left, right } = call.arguments;
  if (Object.keys(call.arguments).length !== 3 ||
      typeof left !== "number" || !Number.isFinite(left) ||
      typeof right !== "number" || !Number.isFinite(right)) {
    return error("INVALID_ARGUMENTS");
  }
  let value: number;
  switch (operation) {
    case "add": value = left + right; break;
    case "subtract": value = left - right; break;
    case "multiply": value = left * right; break;
    case "divide":
      if (right === 0) return error("DIVISION_BY_ZERO");
      value = left / right;
      break;
    default: return error("INVALID_OPERATION");
  }
  if (!Number.isFinite(value)) return error("NONFINITE_RESULT");
  return {
    schemaVersion: SCHEMA_VERSION, providerCallId: call.providerCallId,
    status: "success", content: { value }
  };
}

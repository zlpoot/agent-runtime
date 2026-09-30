import { runAgent, type RunResult } from "@agent-runtime/core";
import {
  ManualGate, ScriptedFakeModel,
  type RuntimeEvent, type ScriptStep, type ToolCall
} from "@agent-runtime/model";
import { executeCalculator } from "@agent-runtime/tools";
import type { DemoOptions } from "./index.js";

function call(id: string, operation: string, left: number, right: number): ToolCall {
  return { providerCallId: id, toolName: "calculator", arguments: { operation, left, right } };
}

export function formatEvent(event: RuntimeEvent): string {
  const ids = [
    "modelTurnId" in event ? event.modelTurnId : "",
    "actionId" in event ? event.actionId : "",
    "attemptId" in event ? event.attemptId : ""
  ].filter(Boolean).join(" ");
  const detail = event.kind === "RunEnded"
    ? `${event.status} reason=${event.reason} modelTurns=${event.modelTurns} toolCalls=${event.toolCalls}`
    : "errorCode" in event ? event.errorCode
      : event.kind === "ModelResponded" ? event.responseKind : "";
  return `[${event.sequence}] ${event.kind} ${ids} ${detail}`.trim();
}

export function outcomeExitCode(result: RunResult): number {
  switch (result.status) {
    case "model_stopped": return 0;
    case "failed": return 1;
    case "budget_exhausted": return 3;
    case "cancelled": return 130;
  }
}

export async function runDemo(
  options: DemoOptions, writeLine: (line: string) => void,
  controller: AbortController = new AbortController()
): Promise<RunResult> {
  const maxModelTurns = options.maxModelTurns ?? (options.scenario === "repeat" ? 3 : 4);
  const maxToolCalls = options.maxToolCalls ?? (options.scenario === "budget" ? 2 : 8);
  let script: readonly ScriptStep[];
  switch (options.scenario) {
    case "normal":
      script = [
        { type: "tool_calls", calls: [call("call-1", "add", 2, 3), call("call-2", "multiply", 4, 5)] },
        { type: "tool_calls", calls: [call("call-3", "divide", 20, 5)], expectToolResultCallId: "call-2" },
        { type: "final", text: "Synthetic calculations finished.", expectToolResultCallId: "call-3" }
      ];
      break;
    case "tool-error":
      script = [{ type: "tool_calls", calls: [call("call-error", "divide", 1, 0)] }];
      break;
    case "model-error":
      script = [{ type: "error", message: "Synthetic model failure." }];
      break;
    case "cancel":
      script = [{ type: "wait", gate: new ManualGate(), then: { type: "final", text: "Never released." } }];
      break;
    default:
      script = Array.from({ length: maxModelTurns + 1 }, (_, index): ScriptStep => ({
        type: "tool_calls", calls: [call(
          options.scenario === "repeat" ? "repeated-call" : `call-${index + 1}`, "add", 1, 1
        )]
      }));
  }
  const fake = new ScriptedFakeModel(script);
  const pending = runAgent({
    model: fake, executeTool: executeCalculator, runId: `demo-${options.scenario}`,
    context: [{ kind: "user", text: "Synthetic calculator exercise." }],
    limits: { maxModelTurns, maxToolCalls }, signal: controller.signal,
    onEvent: (event) => writeLine(options.jsonl ? JSON.stringify(event) : formatEvent(event))
  });
  // runAgent reaches its first model wait before returning this pending promise.
  // The independent demo control injects user cancellation outside the Adapter.
  if (options.scenario === "cancel") controller.abort();
  const result = await pending;
  if (!options.jsonl && result.status === "model_stopped") {
    writeLine("The model stopped. Business completion has not been verified.");
  }
  return result;
}

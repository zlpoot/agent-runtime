import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  type ModelAdapter, type ModelContextItem, type RuntimeEvent,
  type RunEndReason, type RunStatus, type ToolCall, type ToolResult
} from "@agent-runtime/model";
import {
  createRunState, transitionRun,
  type EventDraft, type RunInput, type RunLimits, type RunState
} from "./run-state.js";

export type ToolExecutor = (
  call: ToolCall, options: { readonly signal?: AbortSignal }
) => ToolResult | Promise<ToolResult>;

export interface RunAgentOptions {
  readonly model: ModelAdapter;
  readonly executeTool: ToolExecutor;
  readonly context?: readonly ModelContextItem[];
  readonly runId?: string;
  readonly limits?: Partial<RunLimits>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly onEvent?: (event: RuntimeEvent) => void;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly reason: RunEndReason;
  readonly finalText: string | null;
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly events: readonly RuntimeEvent[];
}

export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => performance.now());
  const started = now();
  const elapsed = (from: number): number => Math.max(0, now() - from);
  let state: RunState = createRunState(runId, options.context ?? [], {
    maxModelTurns: options.limits?.maxModelTurns ?? 8,
    maxToolCalls: options.limits?.maxToolCalls ?? 16
  });
  const events: RuntimeEvent[] = [];
  const emit = (draft: EventDraft): void => {
    const event: RuntimeEvent = {
      ...draft, schemaVersion: EVENT_SCHEMA_VERSION, runId,
      sequence: events.length + 1, elapsedMs: elapsed(started)
    };
    events.push(event);
    options.onEvent?.(structuredClone(event));
  };
  const apply = (input: RunInput) => {
    const transition = transitionRun(state, input);
    state = transition.state;
    for (const event of transition.events) emit(event);
    return transition.command;
  };
  emit({ kind: "RunStarted" });

  while (state.phase !== "ended") {
    if (options.signal?.aborted) {
      apply({ kind: "cancel" });
      break;
    }
    const command = apply({ kind: "advance" });
    if (command.kind === "none") continue;
    if (options.signal?.aborted) {
      apply({ kind: "cancel" });
      break;
    }
    const commandStarted = now();
    const control = options.signal === undefined ? {} : { signal: options.signal };
    let input: RunInput;
    // These are the only model/tool invocation sites; transitions perform no I/O.
    if (command.kind === "request_model") {
      try {
        const value = await options.model.generate(command.request, control);
        input = options.signal?.aborted
          ? { kind: "cancel", durationMs: elapsed(commandStarted) }
          : { kind: "model_returned", value, durationMs: elapsed(commandStarted) };
      } catch {
        input = options.signal?.aborted
          ? { kind: "cancel", durationMs: elapsed(commandStarted) }
          : { kind: "model_threw", durationMs: elapsed(commandStarted) };
      }
    } else {
      try {
        const value = await options.executeTool(command.action.call, control);
        input = { kind: "tool_returned", value, durationMs: elapsed(commandStarted) };
      } catch {
        input = options.signal?.aborted
          ? { kind: "cancel", durationMs: elapsed(commandStarted) }
          : { kind: "tool_threw", durationMs: elapsed(commandStarted) };
      }
    }
    apply(input);
  }
  // TypeScript cannot track assignments inside apply; check the terminal invariant.
  const terminal: RunState = state;
  if (terminal.phase !== "ended") throw new Error("Run must end with a visible outcome.");
  return {
    runId, status: terminal.status, reason: terminal.reason,
    finalText: terminal.finalText, modelTurns: terminal.modelTurns,
    toolCalls: terminal.toolCalls, events
  };
}

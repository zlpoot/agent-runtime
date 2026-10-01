import {
  SCHEMA_VERSION, parseModelRequest, parseModelResponse, parseToolResult,
  type ModelContextItem, type ModelRequest, type RuntimeAction,
  type RuntimeEvent, type RunEndReason, type RunStatus
} from "@agent-runtime/model";

export interface RunLimits {
  readonly maxModelTurns: number;
  readonly maxToolCalls: number;
}

interface StateData {
  readonly runId: string;
  readonly limits: RunLimits;
  readonly context: readonly ModelContextItem[];
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly nextActionNumber: number;
  readonly toolErrorPolicy: "stop" | "feedback";
}

export type RunState = StateData & (
  | { readonly phase: "ready_model" }
  | { readonly phase: "awaiting_model"; readonly modelTurnId: string }
  | { readonly phase: "ready_tool"; readonly modelTurnId: string; readonly queue: readonly RuntimeAction[] }
  | {
      readonly phase: "awaiting_tool";
      readonly modelTurnId: string;
      readonly action: RuntimeAction;
      readonly remaining: readonly RuntimeAction[];
      readonly attemptId: string;
    }
  | {
      readonly phase: "ended";
      readonly status: RunStatus;
      readonly reason: RunEndReason;
      readonly finalText: string | null;
    }
);

type WithoutEnvelope<T> = T extends RuntimeEvent
  ? Omit<T, "schemaVersion" | "runId" | "sequence" | "elapsedMs">
  : never;
export type EventDraft = WithoutEnvelope<RuntimeEvent>;

export type RunCommand =
  | { readonly kind: "request_model"; readonly request: ModelRequest }
  | { readonly kind: "execute_tool"; readonly action: RuntimeAction; readonly attemptId: string }
  | { readonly kind: "none" };

export type RunInput =
  | { readonly kind: "advance" }
  | { readonly kind: "cancel"; readonly durationMs?: number }
  | { readonly kind: "model_returned"; readonly value: unknown; readonly durationMs: number }
  | { readonly kind: "model_threw"; readonly durationMs: number }
  | { readonly kind: "tool_returned"; readonly value: unknown; readonly durationMs: number }
  | { readonly kind: "tool_threw"; readonly durationMs: number };

export interface Transition {
  readonly state: RunState;
  readonly command: RunCommand;
  readonly events: readonly EventDraft[];
}

export function createRunState(
  runId: string, context: readonly ModelContextItem[], limits: RunLimits,
  toolErrorPolicy: "stop" | "feedback" = "stop"
): RunState {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) {
    throw new RangeError("runId must be a short metadata identifier.");
  }
  if (!Number.isSafeInteger(limits.maxModelTurns) || limits.maxModelTurns < 1 ||
      !Number.isSafeInteger(limits.maxToolCalls) || limits.maxToolCalls < 0) {
    throw new RangeError("Run limits must be finite integers: model turns >= 1, tool calls >= 0.");
  }
  const parsed = parseModelRequest({
    schemaVersion: SCHEMA_VERSION, runId, modelTurnId: `${runId}.turn.1`, context
  });
  if (!parsed.ok) throw new TypeError("Invalid initial model context.");
  return {
    phase: "ready_model", runId, context: parsed.value.context,
    limits: { ...limits }, modelTurns: 0, toolCalls: 0, nextActionNumber: 1, toolErrorPolicy
  };
}

function dataOf(state: RunState): StateData {
  return {
    runId: state.runId, context: state.context, limits: state.limits,
    modelTurns: state.modelTurns, toolCalls: state.toolCalls,
    nextActionNumber: state.nextActionNumber, toolErrorPolicy: state.toolErrorPolicy
  };
}

function stop(
  state: RunState, status: RunStatus, reason: RunEndReason,
  events: readonly EventDraft[] = [], finalText: string | null = null
): Transition {
  return {
    state: { ...dataOf(state), phase: "ended", status, reason, finalText },
    command: { kind: "none" },
    events: [...events, {
      kind: "RunEnded", status, reason,
      modelTurns: state.modelTurns, toolCalls: state.toolCalls
    }]
  };
}

// This function chooses commands and state only. It never calls a model or tool.
export function transitionRun(state: RunState, input: RunInput): Transition {
  if (state.phase === "ended") return { state, command: { kind: "none" }, events: [] };
  if (input.kind === "cancel") {
    const events: EventDraft[] = [];
    if (state.phase === "awaiting_model") {
      events.push({ kind: "ModelFailed", modelTurnId: state.modelTurnId,
        errorCode: "ABORTED", durationMs: input.durationMs ?? 0 });
    }
    if (state.phase === "awaiting_tool") {
      events.push({ kind: "ToolFailed", modelTurnId: state.modelTurnId,
        actionId: state.action.actionId, attemptId: state.attemptId,
        errorCode: "ABORTED", durationMs: input.durationMs ?? 0 });
    }
    return stop(state, "cancelled", "ABORTED", events);
  }

  if (input.kind === "advance" && state.phase === "ready_model") {
    if (state.modelTurns >= state.limits.maxModelTurns) {
      return stop(state, "budget_exhausted", "MAX_MODEL_TURNS");
    }
    const modelTurns = state.modelTurns + 1;
    const modelTurnId = `${state.runId}.turn.${modelTurns}`;
    return {
      state: { ...dataOf(state), phase: "awaiting_model", modelTurns, modelTurnId },
      command: { kind: "request_model", request: {
        schemaVersion: SCHEMA_VERSION, runId: state.runId, modelTurnId,
        context: structuredClone(state.context)
      } },
      events: [{ kind: "ModelRequested", modelTurnId }]
    };
  }

  if (input.kind === "advance" && state.phase === "ready_tool") {
    const [action, ...remaining] = state.queue;
    if (action === undefined) throw new Error("Tool queue must be nonempty.");
    if (state.toolCalls >= state.limits.maxToolCalls) {
      return stop(state, "budget_exhausted", "MAX_TOOL_CALLS");
    }
    const attemptId = `${action.actionId}.attempt.1`;
    return {
      state: { ...dataOf(state), phase: "awaiting_tool", modelTurnId: state.modelTurnId,
        action, remaining, attemptId, toolCalls: state.toolCalls + 1 },
      command: { kind: "execute_tool", action: structuredClone(action), attemptId },
      events: [{ kind: "ToolStarted", modelTurnId: state.modelTurnId,
        actionId: action.actionId, attemptId }]
    };
  }

  if (state.phase === "awaiting_model") {
    if (input.kind === "model_threw") {
      return stop(state, "failed", "MODEL_FAILURE", [{
        kind: "ModelFailed", modelTurnId: state.modelTurnId,
        errorCode: "MODEL_FAILURE", durationMs: input.durationMs
      }]);
    }
    if (input.kind === "model_returned") {
      const parsed = parseModelResponse(input.value);
      if (!parsed.ok) {
        return stop(state, "failed", "INVALID_RESPONSE", [{
          kind: "ModelFailed", modelTurnId: state.modelTurnId,
          errorCode: "INVALID_RESPONSE", durationMs: input.durationMs
        }]);
      }
      const response = parsed.value;
      const events: EventDraft[] = [{ kind: "ModelResponded", modelTurnId: state.modelTurnId,
        responseKind: response.kind, durationMs: input.durationMs }];
      if (response.kind === "error") {
        return stop(state, response.error.code === "ABORTED" ? "cancelled" : "failed",
          response.error.code, events);
      }
      if (response.kind === "final") {
        return stop(state, "model_stopped", "MODEL_STOPPED", events, response.text);
      }
      const queue = response.calls.map((call, index): RuntimeAction => ({
        actionId: `${state.runId}.action.${state.nextActionNumber + index}`, call
      }));
      for (const action of queue) {
        events.push({ kind: "ToolProposed", modelTurnId: state.modelTurnId,
          actionId: action.actionId });
      }
      // Keep valid proposals observable, but admit no tool if the batch exceeds budget.
      if (response.calls.length > state.limits.maxToolCalls - state.toolCalls) {
        return stop(state, "budget_exhausted", "MAX_TOOL_CALLS", events);
      }
      return {
        state: { ...dataOf(state), phase: "ready_tool", modelTurnId: state.modelTurnId,
          queue, nextActionNumber: state.nextActionNumber + queue.length,
          context: [...state.context, { kind: "assistant_tool_calls", calls: response.calls }] },
        command: { kind: "none" }, events
      };
    }
  }

  if (state.phase === "awaiting_tool" &&
      (input.kind === "tool_returned" || input.kind === "tool_threw")) {
    const attempt = { modelTurnId: state.modelTurnId, actionId: state.action.actionId,
      attemptId: state.attemptId, durationMs: input.durationMs };
    if (input.kind === "tool_threw") {
      return stop(state, "failed", "EXECUTOR_FAILURE", [{
        kind: "ToolFailed", ...attempt, errorCode: "EXECUTOR_FAILURE"
      }]);
    }
    const parsed = parseToolResult(input.value);
    if (!parsed.ok || parsed.value.providerCallId !== state.action.call.providerCallId) {
      return stop(state, "failed", "INVALID_TOOL_RESULT", [{
        kind: "ToolFailed", ...attempt, errorCode: "INVALID_TOOL_RESULT"
      }]);
    }
    if (parsed.value.error !== undefined &&
      (parsed.value.error.actionId !== state.action.actionId || parsed.value.error.attemptId !== state.attemptId)) {
      return stop(state, "failed", "INVALID_TOOL_RESULT", [{
        kind: "ToolFailed", ...attempt, errorCode: "INVALID_TOOL_RESULT"
      }]);
    }
    const data = { ...dataOf(state), context: [
      ...state.context, { kind: "tool_result" as const, result: parsed.value }
    ] };
    if (parsed.value.status === "error") {
      if (parsed.value.error?.outcome === "unknown") {
        return stop({ ...state, ...data }, "failed", "TOOL_OUTCOME_UNKNOWN", [{
          kind: "ToolFailed", ...attempt, errorCode: "TOOL_OUTCOME_UNKNOWN"
        }]);
      }
      if (parsed.value.error?.code === "CANCELLED" && parsed.value.error.outcome === "not_started") {
        return stop({ ...state, ...data }, "cancelled", "ABORTED", [{
          kind: "ToolFailed", ...attempt, errorCode: "ABORTED"
        }]);
      }
      if (state.toolErrorPolicy === "feedback" && parsed.value.error?.outcome === "not_started") {
        return {
          state: state.remaining.length === 0 ? { ...data, phase: "ready_model" }
            : { ...data, phase: "ready_tool", modelTurnId: state.modelTurnId, queue: state.remaining },
          command: { kind: "none" }, events: [{ kind: "ToolFailed", ...attempt, errorCode: "TOOL_FAILURE" }]
        };
      }
      return stop({ ...state, ...data }, "failed", "TOOL_FAILURE", [{
        kind: "ToolFailed", ...attempt, errorCode: "TOOL_FAILURE"
      }]);
    }
    return {
      state: state.remaining.length === 0
        ? { ...data, phase: "ready_model" }
        : { ...data, phase: "ready_tool", modelTurnId: state.modelTurnId, queue: state.remaining },
      command: { kind: "none" }, events: [{ kind: "ToolSucceeded", ...attempt }]
    };
  }
  throw new Error(`Unexpected ${input.kind} in ${state.phase}.`);
}

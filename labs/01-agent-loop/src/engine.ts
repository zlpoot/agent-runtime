import { runAgent, type RunLimits } from "@agent-runtime/core";
import {
  SCHEMA_VERSION, ScriptedFakeModel, runtimeError,
  type ModelAdapter, type ModelRequest, type ModelResponse, type RuntimeEvent,
  type RunEndReason, type RunStatus, type ScriptStep, type ToolCall, type ToolResult
} from "@agent-runtime/model";
import { executeCalculator } from "@agent-runtime/tools";

export const MODES = ["inspect", "execute", "break", "step"] as const;
export const FAULTS = ["infinite", "no-dispatch", "missing-result", "wrong-call-id"] as const;
export type LabMode = (typeof MODES)[number];
export type LabFault = (typeof FAULTS)[number];
export type FaultLayer = "execution" | "protocol" | "scheduling";

export interface TeachingCheckpoint {
  readonly ordinal: number;
  readonly stage: "before_model_response" | "before_calculator";
}

export interface TeachingPause extends TeachingCheckpoint {
  readonly schemaVersion: 1;
  readonly kind: "TeachingPause";
  readonly runId: string;
  readonly afterRuntimeSequence: number;
}

export interface LabObservation {
  readonly schemaVersion: 1;
  readonly kind: "LabObservation";
  readonly runId: string;
  readonly mode: LabMode;
  readonly fault: LabFault | null;
  readonly faultLayer: FaultLayer | null;
  readonly status: RunStatus | "proposal_only";
  readonly reason: RunEndReason | "PROPOSAL_ONLY";
  readonly modelTurns: number;
  readonly toolCommands: number;
  readonly calculatorExecutions: number;
  readonly lastModelToolResults: number;
  readonly proposedToolCalls: number;
}

export type LabTraceEvent = (RuntimeEvent | TeachingPause | LabObservation) & {
  readonly labSequence: number;
};

export interface LabOptions {
  readonly mode: LabMode;
  readonly fault?: LabFault;
  readonly limits?: Partial<RunLimits>;
  readonly controller?: AbortController;
  readonly now?: () => number;
  readonly onEvent?: (event: LabTraceEvent) => void;
  readonly advance?: (checkpoint: TeachingCheckpoint, signal: AbortSignal) => boolean | Promise<boolean>;
}

const proposal: ToolCall = {
  providerCallId: "lesson-call-1", toolName: "calculator",
  arguments: { operation: "add", left: 2, right: 3 }
};

function lessonScript(): readonly ScriptStep[] {
  return [
    { type: "tool_calls", calls: [proposal] },
    { type: "final", text: "Synthetic model stopped.", expectToolResultCallId: proposal.providerCallId }
  ];
}

// Lab-only source with no final and no finite script-length stopping condition.
export class EndlessProposalModel implements ModelAdapter {
  readonly capabilities = { toolCalls: true, cancellation: true } as const;
  private readonly captured: ModelRequest[] = [];

  get requests(): readonly ModelRequest[] { return structuredClone(this.captured); }

  async generate(request: ModelRequest, control?: { readonly signal?: AbortSignal }): Promise<ModelResponse> {
    const oneTurn = new ScriptedFakeModel([{ type: "tool_calls", calls: [proposal] }]);
    const response = await oneTurn.generate(request, control);
    this.captured.push(...oneTurn.requests);
    return response;
  }
}

export async function runLab(options: LabOptions): Promise<{
  readonly observation: LabObservation;
  readonly events: readonly LabTraceEvent[];
}> {
  if (options.mode === "step" && options.advance === undefined) {
    throw new TypeError("Teaching step requires an independent advance input.");
  }
  if (options.mode !== "break" && options.fault !== undefined) {
    throw new TypeError("Fault injection belongs to break mode.");
  }
  const controller = options.controller ?? new AbortController();
  const fault = options.mode === "break" ? options.fault ?? "infinite" : null;
  const runId = `lab-${options.mode}${fault === null ? "" : `-${fault}`}`;
  const events: LabTraceEvent[] = [];
  const emit = (event: RuntimeEvent | TeachingPause | LabObservation): void => {
    const frame = { ...event, labSequence: events.length + 1 };
    events.push(frame);
    options.onEvent?.(structuredClone(frame));
  };
  let calculatorExecutions = 0;
  let proposedToolCalls = 0;
  let checkpointNumber = 0;
  let runtimeSequence = 0;
  const source = fault === "infinite" ? new EndlessProposalModel() : new ScriptedFakeModel(lessonScript());
  const lastModelToolResults = (): number => source.requests.at(-1)?.context
    .filter((item) => item.kind === "tool_result").length ?? 0;

  const pause = async (stage: TeachingCheckpoint["stage"]): Promise<boolean> => {
    if (controller.signal.aborted) return false;
    if (options.mode !== "step") return true;
    const checkpoint = { ordinal: ++checkpointNumber, stage };
    emit({ ...checkpoint, schemaVersion: 1, kind: "TeachingPause", runId,
      afterRuntimeSequence: runtimeSequence });
    const accepted = await options.advance?.(checkpoint, controller.signal);
    if (accepted !== true) controller.abort();
    return !controller.signal.aborted;
  };
  const model: ModelAdapter = {
    capabilities: source.capabilities,
    async generate(request, control) {
      if (!await pause("before_model_response")) {
        return { schemaVersion: SCHEMA_VERSION, kind: "error",
          error: runtimeError("ABORTED", "Teaching input cancelled.", runId) };
      }
      // Drop the outbound results only in this injected experiment adapter.
      const delivered = fault === "missing-result"
        ? { ...request, context: request.context.filter((item) => item.kind !== "tool_result") }
        : request;
      return source.generate(delivered, control);
    }
  };

  let observation: LabObservation;
  if (options.mode === "inspect") {
    const response = await model.generate({ schemaVersion: SCHEMA_VERSION, runId,
      modelTurnId: `${runId}.turn.1`, context: [{ kind: "user", text: "Synthetic lesson input." }] },
    { signal: controller.signal });
    const isProposal = response.kind === "tool_calls";
    observation = {
      schemaVersion: 1, kind: "LabObservation", runId, mode: options.mode, fault, faultLayer: null,
      status: isProposal ? "proposal_only" : response.kind === "error" && response.error.code === "ABORTED"
        ? "cancelled" : "failed",
      reason: isProposal ? "PROPOSAL_ONLY" : response.kind === "error" ? response.error.code : "INVALID_RESPONSE",
      modelTurns: source.requests.length, toolCommands: 0, calculatorExecutions,
      lastModelToolResults: lastModelToolResults(), proposedToolCalls: isProposal ? response.calls.length : 0
    };
  } else {
    const result = await runAgent({
      model, runId, signal: controller.signal,
      context: [{ kind: "user", text: "Synthetic lesson input." }],
      limits: { maxModelTurns: options.limits?.maxModelTurns ?? 3,
        maxToolCalls: options.limits?.maxToolCalls ?? 6 },
      ...(options.now === undefined ? {} : { now: options.now }),
      onEvent(event) {
        runtimeSequence = event.sequence;
        if (event.kind === "ToolProposed") proposedToolCalls++;
        emit(event);
      },
      async executeTool(call): Promise<ToolResult> {
        if (!await pause("before_calculator")) throw new Error("Teaching input cancelled.");
        if (fault === "no-dispatch") {
          return { schemaVersion: SCHEMA_VERSION, providerCallId: call.providerCallId,
            status: "error", content: { code: "DISPATCH_REMOVED" } };
        }
        calculatorExecutions++;
        const result = executeCalculator(call);
        return fault === "wrong-call-id" ? { ...result, providerCallId: "wrong-lesson-call" } : result;
      }
    });
    observation = {
      schemaVersion: 1, kind: "LabObservation", runId, mode: options.mode, fault,
      faultLayer: fault === null ? null : fault === "infinite" ? "scheduling"
        : fault === "no-dispatch" ? "execution" : "protocol",
      status: result.status, reason: result.reason, modelTurns: result.modelTurns,
      toolCommands: result.toolCalls, calculatorExecutions,
      lastModelToolResults: lastModelToolResults(), proposedToolCalls
    };
  }
  emit(observation);
  return { observation, events };
}

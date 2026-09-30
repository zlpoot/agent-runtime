import {
  SCHEMA_VERSION,
  parseModelRequest,
  parseModelResponse,
  runtimeError,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse
} from "./protocol.js";

export class ManualGate {
  private released = false;
  private readonly waiters = new Set<(released: boolean) => void>();

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const waiter of this.waiters) waiter(true);
    this.waiters.clear();
  }

  wait(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.released) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (released: boolean): void => {
        this.waiters.delete(finish);
        signal?.removeEventListener("abort", onAbort);
        resolve(released);
      };
      const onAbort = (): void => finish(false);
      this.waiters.add(finish);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) finish(false);
    });
  }
}

type Outcome =
  | { readonly type: "final"; readonly text: string; readonly expectToolResultCallId?: string }
  | { readonly type: "tool_calls"; readonly calls: unknown; readonly expectToolResultCallId?: string }
  | { readonly type: "error"; readonly message: string; readonly expectToolResultCallId?: string }
  | { readonly type: "raw"; readonly value: unknown; readonly expectToolResultCallId?: string };

export type ScriptStep = Outcome | { readonly type: "wait"; readonly gate: ManualGate; readonly then: Outcome };

export class ScriptedFakeModel implements ModelAdapter {
  readonly capabilities = { toolCalls: true, cancellation: true } as const;
  private cursor = 0;
  private readonly capturedRequests: ModelRequest[] = [];

  constructor(private readonly script: readonly ScriptStep[]) {}

  get requests(): readonly ModelRequest[] {
    return structuredClone(this.capturedRequests);
  }

  get remainingSteps(): number {
    return this.script.length - this.cursor;
  }

  async generate(
    request: ModelRequest,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<ModelResponse> {
    const parsedRequest = parseModelRequest(request);
    if (!parsedRequest.ok) {
      return this.error(parsedRequest.error.code, parsedRequest.error.message);
    }
    const runId = parsedRequest.value.runId;
    this.capturedRequests.push(parsedRequest.value);
    if (options.signal?.aborted) return this.error("ABORTED", "Model turn aborted.", runId);

    const step = this.script[this.cursor++];
    if (step === undefined) {
      return this.error("SCRIPT_EXHAUSTED", "Script has no remaining response.", runId);
    }
    let outcome: Outcome;
    if (step.type === "wait") {
      const released = await step.gate.wait(options.signal);
      if (!released) return this.error("ABORTED", "Model turn aborted.", runId);
      outcome = step.then;
    } else {
      outcome = step;
    }
    if (options.signal?.aborted) return this.error("ABORTED", "Model turn aborted.", runId);

    if (
      outcome.expectToolResultCallId !== undefined &&
      !parsedRequest.value.context.some(
        (item) => item.kind === "tool_result" &&
          item.result.providerCallId === outcome.expectToolResultCallId
      )
    ) {
      return this.error(
        "EXPECTED_TOOL_RESULT_MISSING",
        `Expected tool result for call ${outcome.expectToolResultCallId}.`,
        runId
      );
    }

    if (outcome.type === "error") {
      if (outcome.message.trim().length === 0) {
        return this.error("INVALID_RESPONSE", "Model failure message must be nonempty.", runId);
      }
      return this.error("MODEL_FAILURE", outcome.message, runId);
    }
    const candidate: unknown = outcome.type === "raw"
      ? outcome.value
      : outcome.type === "final"
        ? { schemaVersion: SCHEMA_VERSION, kind: "final", text: outcome.text }
        : { schemaVersion: SCHEMA_VERSION, kind: "tool_calls", calls: outcome.calls };
    const parsedResponse = parseModelResponse(candidate);
    return parsedResponse.ok
      ? parsedResponse.value
      : this.error("INVALID_RESPONSE", parsedResponse.error.message, runId);
  }

  private error(
    code: Parameters<typeof runtimeError>[0],
    message: string,
    runId?: string
  ): ModelResponse {
    return { schemaVersion: SCHEMA_VERSION, kind: "error", error: runtimeError(code, message, runId) };
  }
}

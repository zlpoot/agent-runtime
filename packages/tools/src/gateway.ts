import {
  SCHEMA_VERSION, type JsonObject, type JsonValue, type ToolCall, type ToolErrorCode,
  type ToolOutcome, type ToolResult
} from "@agent-runtime/model";
import { boundedJson, JsonBoundaryError, redactJson } from "./json-boundary.js";
import { ToolFault, ToolRegistry, type ToolControl } from "./registry.js";

export interface ExecutionControl {
  readonly actionId: string;
  readonly attemptId: string;
  readonly signal?: AbortSignal;
}
export interface GatewayEvent {
  readonly schemaVersion: 1;
  readonly kind: "GatewayInvoked" | "GatewayRejected" | "GatewaySucceeded" | "GatewayFailed";
  readonly actionId: string;
  readonly attemptId: string;
  readonly code?: ToolErrorCode;
  readonly outcome?: ToolOutcome;
}
export interface GatewayOptions {
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxDepth?: number;
  readonly maxTextChars?: number;
  readonly secrets?: readonly string[];
  readonly onEvent?: (event: GatewayEvent) => void;
  readonly schedule?: (delayMs: number, fire: () => void) => () => void;
}
const messages: Record<ToolErrorCode, string> = {
  VALIDATION_ERROR: "Input does not match the registered tool contract.",
  TOOL_NOT_FOUND: "Tool is not registered.", EXECUTION_ERROR: "Trusted tool execution failed.",
  TIMEOUT: "Tool deadline elapsed; check outcome before any new action.",
  CANCELLED: "Tool invocation was cancelled; check outcome before any new action.",
  INPUT_LIMIT_EXCEEDED: "Input exceeds the JSON size or depth limit.",
  OUTPUT_LIMIT_EXCEEDED: "Output exceeds the JSON size or depth limit.",
  INVALID_OUTPUT: "Tool output does not match its registered contract.",
  PATH_NOT_ALLOWED: "File resource is outside the configured restricted workspace contract.",
  BUSY: "An earlier invocation is still unsettled; no new tool was started."
};
type Packet = { readonly kind: "success"; readonly output: JsonValue }
  | { readonly kind: "failure"; readonly code: ToolErrorCode; readonly outcome: ToolOutcome };

export class ToolGateway {
  #active = false;
  readonly #inputBytes: number;
  readonly #outputBytes: number;
  readonly #depth: number;
  readonly #textChars: number;
  readonly #secrets: readonly string[];
  readonly #schedule: NonNullable<GatewayOptions["schedule"]>;
  constructor(readonly registry: ToolRegistry, private readonly options: GatewayOptions = {}) {
    this.#inputBytes = options.maxInputBytes ?? 16_384;
    this.#outputBytes = options.maxOutputBytes ?? 16_384;
    this.#depth = options.maxDepth ?? 8;
    this.#textChars = options.maxTextChars ?? 1024;
    for (const limit of [this.#inputBytes, this.#outputBytes, this.#depth, this.#textChars]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Gateway limits must be finite positive integers.");
    }
    this.#secrets = [...(options.secrets ?? [])];
    this.#schedule = options.schedule ?? ((delay, fire) => {
      const timer = setTimeout(fire, delay);
      return () => clearTimeout(timer);
    });
  }
  readonly execute = (call: ToolCall, control: ExecutionControl): Promise<ToolResult> => this.invoke(call, control);

  async invoke(value: unknown, control: ExecutionControl): Promise<ToolResult> {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(control.actionId) ||
      !/^[A-Za-z0-9._-]{1,180}$/.test(control.attemptId)) throw new TypeError("Invalid trusted execution identifiers.");
    const ids = { actionId: control.actionId, attemptId: control.attemptId };
    const emit = (event: Omit<GatewayEvent, "schemaVersion" | "actionId" | "attemptId">): void => {
      this.options.onEvent?.({ schemaVersion: 1, ...ids, ...event });
    };
    let providerCallId = "invalid-call";
    // Preserve correlation for invalid arguments without evaluating accessors.
    if (value !== null && typeof value === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(value, "providerCallId");
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
        && descriptor.value.length > 0 && descriptor.value.length <= 160) providerCallId = descriptor.value;
    }
    const failure = (code: ToolErrorCode, outcome: ToolOutcome): ToolResult => {
      emit({ kind: outcome === "not_started" ? "GatewayRejected" : "GatewayFailed", code, outcome });
      return { schemaVersion: SCHEMA_VERSION, providerCallId, status: "error", content: { code },
        error: { ...ids, code, outcome, message: messages[code] } };
    };
    let call: ToolCall;
    try {
      const data = boundedJson(value, { maxBytes: this.#inputBytes, maxDepth: this.#depth });
      if (data === null || typeof data !== "object" || Array.isArray(data)) throw new JsonBoundaryError("invalid");
      const object = data as JsonObject;
      if (Object.keys(object).length !== 3 || typeof object.providerCallId !== "string" ||
        object.providerCallId.trim().length === 0 || object.providerCallId.length > 160 ||
        typeof object.toolName !== "string" || !/^[a-z][a-z0-9_]{0,47}$/.test(object.toolName) ||
        object.arguments === null || typeof object.arguments !== "object" || Array.isArray(object.arguments)) {
        throw new JsonBoundaryError("invalid");
      }
      call = object as unknown as ToolCall;
      providerCallId = call.providerCallId;
    } catch (error) {
      return failure(error instanceof JsonBoundaryError && error.reason !== "invalid"
        ? "INPUT_LIMIT_EXCEEDED" : "VALIDATION_ERROR", "not_started");
    }
    if (control.signal?.aborted) return failure("CANCELLED", "not_started");
    if (this.#active) return failure("BUSY", "not_started");
    const entry = this.registry.lookup(call.toolName);
    if (entry === undefined) return failure("TOOL_NOT_FOUND", "not_started");
    if (!entry.validateInput(call.arguments)) return failure("VALIDATION_ERROR", "not_started");
    const local = new AbortController();
    const toolControl: ToolControl = { ...ids, signal: local.signal };
    let started = false;
    this.#active = true;
    let releaseInterrupt!: (result: Packet) => void;
    const interrupted = new Promise<Packet>((resolve) => {
      releaseInterrupt = resolve;
    });
    const interrupt = (code: "TIMEOUT" | "CANCELLED"): void => {
      releaseInterrupt({ kind: "failure", code, outcome: started ? "unknown" : "not_started" });
      local.abort();
    };
    const cancel = (): void => interrupt("CANCELLED");
    control.signal?.addEventListener("abort", cancel, { once: true });
    const stopTimer = this.#schedule(entry.definition.timeoutMs, () => interrupt("TIMEOUT"));
    // Keep the gateway busy until the implementation really settles, even after timeout.
    const worker = (async (): Promise<Packet> => {
      try {
        await entry.prepare?.(call.arguments, toolControl);
        if (local.signal.aborted) return { kind: "failure", code: "CANCELLED", outcome: "not_started" };
        started = true;
        emit({ kind: "GatewayInvoked" });
        const raw = await entry.execute(call.arguments, toolControl);
        let output;
        try { output = boundedJson(raw, { maxBytes: this.#outputBytes, maxDepth: this.#depth }); }
        catch (error) {
          throw new ToolFault(error instanceof JsonBoundaryError && error.reason !== "invalid"
            ? "OUTPUT_LIMIT_EXCEEDED" : "INVALID_OUTPUT", entry.definition.effects === "pure" ? "failed" : "unknown");
        }
        if (!entry.validateOutput(output)) throw new ToolFault("INVALID_OUTPUT", entry.definition.effects === "pure" ? "failed" : "unknown");
        let clean;
        try {
          clean = boundedJson(redactJson(output, this.#secrets, this.#textChars),
            { maxBytes: this.#outputBytes, maxDepth: this.#depth });
        } catch {
          throw new ToolFault("OUTPUT_LIMIT_EXCEEDED", entry.definition.effects === "pure" ? "failed" : "unknown");
        }
        if (!entry.validateOutput(clean)) throw new ToolFault("INVALID_OUTPUT", entry.definition.effects === "pure" ? "failed" : "unknown");
        return { kind: "success", output: clean };
      } catch (error) {
        return { kind: "failure", code: error instanceof ToolFault ? error.code : "EXECUTION_ERROR" as const,
          outcome: error instanceof ToolFault ? error.outcome : !started ? "not_started" as const
            : entry.definition.effects === "pure" ? "failed" as const : "unknown" as const };
      } finally { this.#active = false; }
    })();
    try {
      const result = await Promise.race([worker, interrupted]);
      if (result.kind === "failure") return failure(result.code, result.outcome);
      emit({ kind: "GatewaySucceeded" });
      return { schemaVersion: SCHEMA_VERSION, providerCallId, status: "success", content: result.output };
    } finally {
      stopTimer();
      control.signal?.removeEventListener("abort", cancel);
    }
  }
}

export const SCHEMA_VERSION = 1 as const;
export const EVENT_SCHEMA_VERSION = 2 as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ToolCall {
  readonly providerCallId: string;
  readonly toolName: string;
  readonly arguments: JsonObject;
}

// Assigned by the Runtime after it accepts a complete provider proposal.
export interface RuntimeAction {
  readonly actionId: string;
  readonly call: ToolCall;
}

export interface ToolResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly providerCallId: string;
  readonly status: "success" | "error";
  readonly content: JsonValue;
}

export type ModelContextItem =
  | { readonly kind: "user" | "assistant"; readonly text: string }
  | { readonly kind: "assistant_tool_calls"; readonly calls: readonly ToolCall[] }
  | { readonly kind: "tool_result"; readonly result: ToolResult };

export interface ModelRequest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly modelTurnId: string;
  readonly context: readonly ModelContextItem[];
}

export const RUNTIME_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_RESPONSE",
  "SCRIPT_EXHAUSTED",
  "MODEL_FAILURE",
  "ABORTED",
  "EXPECTED_TOOL_RESULT_MISSING",
  "TOOL_FAILURE",
  "EXECUTOR_FAILURE",
  "INVALID_TOOL_RESULT",
  "MAX_MODEL_TURNS",
  "MAX_TOOL_CALLS"
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

export interface RuntimeError {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly runId?: string;
}

export type ModelResponse =
  | {
      readonly schemaVersion: typeof SCHEMA_VERSION;
      readonly kind: "final";
      readonly text: string;
    }
  | {
      readonly schemaVersion: typeof SCHEMA_VERSION;
      readonly kind: "tool_calls";
      readonly calls: readonly ToolCall[];
    }
  | {
      readonly schemaVersion: typeof SCHEMA_VERSION;
      readonly kind: "error";
      readonly error: RuntimeError;
    };

export type RunStatus = "model_stopped" | "failed" | "budget_exhausted" | "cancelled";
export type RunEndReason = "MODEL_STOPPED" | RuntimeErrorCode;

interface EventBase {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly runId: string;
  readonly sequence: number;
  readonly elapsedMs: number;
}

interface TurnEvent extends EventBase {
  readonly modelTurnId: string;
}

interface ActionEvent extends TurnEvent {
  readonly actionId: string;
}

interface AttemptEvent extends ActionEvent {
  readonly attemptId: string;
  readonly durationMs: number;
}

// Trace events contain only Runtime metadata, never request/response bodies.
export type RuntimeEvent =
  | (EventBase & { readonly kind: "RunStarted" })
  | (TurnEvent & { readonly kind: "ModelRequested" })
  | (TurnEvent & {
      readonly kind: "ModelResponded";
      readonly responseKind: ModelResponse["kind"];
      readonly durationMs: number;
    })
  | (TurnEvent & {
      readonly kind: "ModelFailed";
      readonly errorCode: RuntimeErrorCode;
      readonly durationMs: number;
    })
  | (ActionEvent & { readonly kind: "ToolProposed" })
  | (ActionEvent & { readonly kind: "ToolStarted"; readonly attemptId: string })
  | (AttemptEvent & { readonly kind: "ToolSucceeded" })
  | (AttemptEvent & { readonly kind: "ToolFailed"; readonly errorCode: RuntimeErrorCode })
  | (EventBase & {
      readonly kind: "RunEnded";
      readonly status: RunStatus;
      readonly reason: RunEndReason;
      readonly modelTurns: number;
      readonly toolCalls: number;
    });

export interface ModelCapabilities {
  readonly toolCalls: boolean;
  readonly cancellation: boolean;
}

// AbortSignal is local control input, not part of the JSON request contract.
export interface ModelAdapter {
  readonly capabilities: ModelCapabilities;
  generate(
    request: ModelRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<ModelResponse>;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RuntimeError };

export function runtimeError(
  code: RuntimeErrorCode,
  message: string,
  runId?: string
): RuntimeError {
  const base = { schemaVersion: SCHEMA_VERSION, code, message };
  return runId === undefined ? base : { ...base, runId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = Reflect.ownKeys(value).length === value.length + 1;
    for (let index = 0; valid && index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      valid = descriptor !== undefined && "value" in descriptor &&
        isJsonValue(descriptor.value, ancestors);
    }
  } else {
    valid = Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true &&
        "value" in descriptor && isJsonValue(descriptor.value, ancestors);
    });
  }
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value);
}

function parseToolCall(value: unknown): ToolCall | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.providerCallId) ||
    !isNonEmptyString(value.toolName) ||
    !isJsonObject(value.arguments)
  ) {
    return null;
  }
  return {
    providerCallId: value.providerCallId,
    toolName: value.toolName,
    arguments: structuredClone(value.arguments)
  };
}

function readToolResult(value: unknown): ToolResult | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !isNonEmptyString(value.providerCallId) ||
    (value.status !== "success" && value.status !== "error") ||
    !isJsonValue(value.content)
  ) {
    return null;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    providerCallId: value.providerCallId,
    status: value.status,
    content: structuredClone(value.content)
  };
}

export function parseToolResult(value: unknown): ParseResult<ToolResult> {
  const result = readToolResult(value);
  return result === null
    ? { ok: false, error: runtimeError("INVALID_TOOL_RESULT", "Invalid tool result.") }
    : { ok: true, value: result };
}

function parseRuntimeError(value: unknown): RuntimeError | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !RUNTIME_ERROR_CODES.some((code) => code === value.code) ||
    !isNonEmptyString(value.message) ||
    (value.runId !== undefined && !isNonEmptyString(value.runId))
  ) {
    return null;
  }
  return runtimeError(
    value.code as RuntimeErrorCode,
    value.message,
    value.runId as string | undefined
  );
}

export function parseModelRequest(value: unknown): ParseResult<ModelRequest> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.modelTurnId) ||
    !Array.isArray(value.context)
  ) {
    return { ok: false, error: runtimeError("INVALID_REQUEST", "Invalid model request.") };
  }

  const context: ModelContextItem[] = [];
  for (const item of value.context) {
    if (!isRecord(item)) {
      return { ok: false, error: runtimeError("INVALID_REQUEST", "Invalid context item.") };
    }
    if ((item.kind === "user" || item.kind === "assistant") && typeof item.text === "string") {
      context.push({ kind: item.kind, text: item.text });
      continue;
    }
    if (item.kind === "tool_result") {
      const result = readToolResult(item.result);
      if (result !== null) {
        context.push({ kind: "tool_result", result });
        continue;
      }
    }
    if (item.kind === "assistant_tool_calls") {
      const response = parseModelResponse({
        schemaVersion: SCHEMA_VERSION, kind: "tool_calls", calls: item.calls
      });
      if (response.ok && response.value.kind === "tool_calls") {
        context.push({ kind: "assistant_tool_calls", calls: response.value.calls });
        continue;
      }
    }
    return { ok: false, error: runtimeError("INVALID_REQUEST", "Invalid context item.") };
  }

  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      runId: value.runId,
      modelTurnId: value.modelTurnId,
      context
    }
  };
}

export function parseModelResponse(value: unknown): ParseResult<ModelResponse> {
  const invalid = (message: string): ParseResult<ModelResponse> => ({
    ok: false,
    error: runtimeError("INVALID_RESPONSE", message)
  });
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    return invalid("Invalid model response schema version.");
  }
  if (value.kind === "final") {
    return isNonEmptyString(value.text)
      ? { ok: true, value: { schemaVersion: SCHEMA_VERSION, kind: "final", text: value.text } }
      : invalid("Final response text must be nonempty.");
  }
  if (value.kind === "tool_calls") {
    if (!Array.isArray(value.calls) || value.calls.length === 0) {
      return invalid("Tool calls must be a nonempty array.");
    }
    const calls: ToolCall[] = [];
    const ids = new Set<string>();
    for (const item of value.calls) {
      const call = parseToolCall(item);
      if (call === null) {
        return invalid("Invalid tool call or non-JSON arguments.");
      }
      if (ids.has(call.providerCallId)) {
        return invalid("Duplicate provider call ID in one response.");
      }
      ids.add(call.providerCallId);
      calls.push(call);
    }
    return { ok: true, value: { schemaVersion: SCHEMA_VERSION, kind: "tool_calls", calls } };
  }
  if (value.kind === "error") {
    const error = parseRuntimeError(value.error);
    return error === null
      ? invalid("Invalid model error response.")
      : { ok: true, value: { schemaVersion: SCHEMA_VERSION, kind: "error", error } };
  }
  return invalid("Unknown model response kind.");
}

export function decodeModelResponse(json: string): ParseResult<ModelResponse> {
  try {
    const value: unknown = JSON.parse(json);
    return parseModelResponse(value);
  } catch {
    return {
      ok: false,
      error: runtimeError("INVALID_RESPONSE", "Model response is not valid JSON.")
    };
  }
}

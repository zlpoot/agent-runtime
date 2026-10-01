import { Ajv, type ValidateFunction } from "ajv";
import type { JsonObject, JsonValue, ToolErrorCode, ToolOutcome } from "@agent-runtime/model";
import { boundedJson } from "./json-boundary.js";

export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly effects: "pure" | "read_workspace" | "write_workspace";
  readonly resources: readonly "workspace"[];
  readonly timeoutMs: number;
  readonly cancellation: "cooperative";
}
export interface ToolControl { readonly signal: AbortSignal; readonly actionId: string; readonly attemptId: string }
export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly prepare?: (input: JsonObject, control: ToolControl) => void | Promise<void>;
  readonly execute: (input: JsonObject, control: ToolControl) => unknown | Promise<unknown>;
}
export class ToolFault extends Error {
  constructor(readonly code: ToolErrorCode, readonly outcome: ToolOutcome) { super("Tool boundary failed."); }
}
interface CompiledTool extends RegisteredTool {
  readonly validateInput: ValidateFunction;
  readonly validateOutput: ValidateFunction;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class ToolRegistry {
  readonly #entries = new Map<string, CompiledTool>();
  constructor(tools: readonly RegisteredTool[]) {
    const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false,
      useDefaults: false, removeAdditional: false, messages: false, ownProperties: true });
    for (const tool of tools) {
      const definition = freeze(boundedJson(tool.definition, { maxBytes: 32_768, maxDepth: 16 })) as unknown as ToolDefinition;
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(definition.name) || this.#entries.has(definition.name) ||
        !/^\d+\.\d+\.\d+$/.test(definition.version) || typeof definition.description !== "string" ||
        !["pure", "read_workspace", "write_workspace"].includes(definition.effects) ||
        !Array.isArray(definition.resources) || definition.resources.some((resource) => resource !== "workspace") ||
        !Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > 60_000 ||
        definition.cancellation !== "cooperative") throw new TypeError("Invalid or duplicate trusted tool definition.");
      const validateInput = ajv.compile(definition.inputSchema);
      const validateOutput = ajv.compile(definition.outputSchema);
      if (("$async" in validateInput && validateInput.$async === true) ||
        ("$async" in validateOutput && validateOutput.$async === true) || typeof tool.execute !== "function") {
        throw new TypeError("Only synchronous trusted schemas and callable implementations are supported.");
      }
      this.#entries.set(definition.name, Object.freeze({ definition, execute: tool.execute,
        ...(tool.prepare === undefined ? {} : { prepare: tool.prepare }),
        validateInput, validateOutput }));
    }
  }
  definitions(): readonly ToolDefinition[] { return structuredClone([...this.#entries.values()].map((entry) => entry.definition)); }
  lookup(name: string): CompiledTool | undefined { return this.#entries.get(name); }
}

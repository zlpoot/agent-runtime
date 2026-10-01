import type { JsonValue } from "@agent-runtime/model";

export interface JsonLimits { readonly maxBytes: number; readonly maxDepth: number }
export class JsonBoundaryError extends Error {
  constructor(readonly reason: "invalid" | "size" | "depth") { super("JSON boundary rejected."); }
}

// Inspect descriptors before cloning/serializing: reject getters, toJSON, cycles and non-JSON values.
export function boundedJson(value: unknown, limits: JsonLimits): JsonValue {
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > limits.maxBytes) throw new JsonBoundaryError("size");
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > limits.maxDepth) throw new JsonBoundaryError("depth");
    if (item === null || typeof item === "boolean" || typeof item === "string" || typeof item === "number") {
      if (typeof item === "number" && !Number.isFinite(item)) throw new JsonBoundaryError("invalid");
      if (typeof item === "string" && item.length > limits.maxBytes) throw new JsonBoundaryError("size");
      add(Buffer.byteLength(JSON.stringify(item), "utf8"));
      return;
    }
    if (typeof item !== "object" || ancestors.has(item)) throw new JsonBoundaryError("invalid");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      throw new JsonBoundaryError("invalid");
    }
    ancestors.add(item);
    add(2);
    const keys = Reflect.ownKeys(item);
    if (keys.length > limits.maxBytes) throw new JsonBoundaryError("size");
    const array = Array.isArray(item);
    if (array && keys.length !== item.length + 1) throw new JsonBoundaryError("invalid");
    const fields = array ? Array.from({ length: item.length }, (_, index) => String(index)) : keys;
    for (let index = 0; index < fields.length; index++) {
      const key = fields[index]!;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== "string" || descriptor?.enumerable !== true || !("value" in descriptor)) {
        throw new JsonBoundaryError("invalid");
      }
      if (!array) add(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
      if (index > 0) add(1);
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function redactJson(value: JsonValue, secrets: readonly string[], maxTextChars: number): JsonValue {
  const text = (input: string): string => {
    let clean = input;
    for (const secret of secrets) if (secret.length > 0) clean = clean.split(secret).join("[REDACTED]");
    clean = clean.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
      .replace(/((?:api[_-]?key|password|token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
    return clean.length > maxTextChars ? clean.slice(0, maxTextChars) + "[TRUNCATED]" : clean;
  };
  const visit = (item: JsonValue): JsonValue => {
    if (typeof item === "string") return text(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === "object") {
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const [key, child] of Object.entries(item)) {
        // Keys may also contain configured synthetic secrets.
        result[text(key)] = /secret|password|token|api[_-]?key/i.test(key) ? "[REDACTED]" : visit(child);
      }
      return result;
    }
    return item;
  };
  return visit(value);
}

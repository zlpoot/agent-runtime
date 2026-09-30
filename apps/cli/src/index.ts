export const SCENARIOS = ["normal", "budget", "tool-error", "repeat", "cancel", "model-error"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface DemoOptions {
  readonly scenario: Scenario;
  readonly jsonl: boolean;
  readonly maxModelTurns?: number;
  readonly maxToolCalls?: number;
}

export interface CliResponse {
  readonly exitCode: number;
  readonly message: string;
  readonly demo?: DemoOptions;
}

const help = `Agent Runtime Lab (Issue #4 serial loop)

Usage: node apps/cli/dist/main.js --help
       node apps/cli/dist/main.js demo [--scenario normal|budget|tool-error|repeat|cancel|model-error]
            [--jsonl] [--max-model-turns N] [--max-tool-calls N]

The demo uses Scripted Fake Model and a pure calculator. It does not contact a real model.
JSONL contains metadata only. Model final means the model stopped; business completion is not verified.`;

export function resolveCliArgs(args: readonly string[]): CliResponse {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return { exitCode: 0, message: help };
  }
  const invalid = (message: string): CliResponse => ({
    exitCode: 2, message: `${message} Run node apps/cli/dist/main.js --help.`
  });
  if (args[0] !== "demo") return invalid("Unknown command.");
  let scenario: Scenario = "normal";
  let jsonl = false;
  let maxModelTurns: number | undefined;
  let maxToolCalls: number | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === undefined || seen.has(flag)) return invalid("Invalid or duplicate option.");
    seen.add(flag);
    if (flag === "--jsonl") { jsonl = true; continue; }
    const value = args[++index];
    if (value === undefined) return invalid("Missing option value.");
    if (flag === "--scenario") {
      const selected = SCENARIOS.find((item) => item === value);
      if (selected === undefined) return invalid("Unknown scenario.");
      scenario = selected;
    } else if (flag === "--max-model-turns" || flag === "--max-tool-calls") {
      const number = Number(value);
      const minimum = flag === "--max-model-turns" ? 1 : 0;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > 1000) {
        return invalid("Limits must be integers within 0..1000; model turns must be at least 1.");
      }
      if (flag === "--max-model-turns") maxModelTurns = number;
      else maxToolCalls = number;
    } else return invalid("Unknown option.");
  }
  return {
    exitCode: 0, message: "",
    demo: { scenario, jsonl,
      ...(maxModelTurns === undefined ? {} : { maxModelTurns }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }) }
  };
}

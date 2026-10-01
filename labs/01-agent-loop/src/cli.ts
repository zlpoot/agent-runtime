import { FAULTS, MODES, type LabFault, type LabMode } from "./engine.js";

export interface CliOptions {
  readonly mode: LabMode;
  readonly fault?: LabFault;
  readonly jsonl: boolean;
  readonly limits: { readonly maxModelTurns: number; readonly maxToolCalls: number };
}

export const HELP = `Usage: pnpm lab agent-loop <inspect|execute|break|step> [options]
  --fault infinite|no-dispatch|missing-result|wrong-call-id  (break only)
  --max-model-turns N  positive integer, default 3
  --max-tool-calls N   nonnegative integer, default 6
  --jsonl             sanitized metadata only on stdout
  --help              show this help
step: predict, then press Enter; non-empty input (e.g. q), EOF or Ctrl+C cancels.
This teaching pause is in memory; it cannot resume after process exit.`;

export function parseArgs(args: readonly string[]): CliOptions | "help" {
  if (args.length === 0 || args.includes("--help")) return "help";
  const [entry, mode, ...rest] = args;
  if (entry !== "agent-loop" || !MODES.includes(mode as LabMode)) {
    throw new TypeError("Expected agent-loop and one of inspect, execute, break, step.");
  }
  let jsonl = false;
  let fault: LabFault | undefined;
  let maxModelTurns = 3;
  let maxToolCalls = 6;
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (seen.has(flag)) throw new TypeError(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--jsonl") { jsonl = true; continue; }
    if (!["--fault", "--max-model-turns", "--max-tool-calls"].includes(flag)) {
      throw new TypeError(`Unknown option: ${flag}`);
    }
    const value = rest[++index];
    if (flag === "--fault") {
      if (mode !== "break" || !FAULTS.includes(value as LabFault)) {
        throw new TypeError("--fault requires break and a supported fault name.");
      }
      fault = value as LabFault;
      continue;
    }
    const number = Number(value);
    if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(number)
      || (flag === "--max-model-turns" && number === 0)) {
      throw new TypeError(`${flag} requires a finite integer within its allowed range.`);
    }
    if (flag === "--max-model-turns") maxModelTurns = number;
    else maxToolCalls = number;
  }
  return { mode: mode as LabMode, jsonl, limits: { maxModelTurns, maxToolCalls },
    ...(fault === undefined ? {} : { fault }) };
}

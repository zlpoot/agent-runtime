export interface CliResponse {
  readonly exitCode: number;
  readonly message: string;
}

const help = `Agent Runtime Lab (Issue #2 scaffold)

Usage: agent-runtime-lab --help

Runtime commands are not available yet. This command does not contact a model or execute tools.`;

export function resolveCliArgs(args: readonly string[]): CliResponse {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return { exitCode: 0, message: help };
  }

  return {
    exitCode: 2,
    message: "Unknown command. Run with --help to see the scaffold status."
  };
}

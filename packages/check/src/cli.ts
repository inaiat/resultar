#!/usr/bin/env node
import { runResultarCheckCli } from "./lint.js";

const usage = `Usage: resultar-check

Runs TypeScript 7 with no emit first, then all enabled Resultar diagnostics from tsconfig plugin options.
`;

const run = (args: readonly string[] = process.argv.slice(2)): number => {
  const [command] = args;

  if (command === "check") {
    process.stderr.write("The check subcommand was removed. Use resultar-check.\n");
    return 1;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return 0;
  }

  if (command === "patch" || command === "doctor" || command === "unpatch") {
    process.stderr.write(`${command} was removed. Use resultar-check with TypeScript 7.\n`);
    return 1;
  }

  return runResultarCheckCli(args);
};

try {
  process.exitCode = run();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

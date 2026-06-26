#!/usr/bin/env node
import { createRequire } from "node:module";

interface ResultarCheckPlugin {
  readonly runResultarCheckCli: (args?: readonly string[]) => number;
}

const requirePackage = createRequire(import.meta.url);
const resultarCheck = requirePackage("resultar-check") as ResultarCheckPlugin;

process.stderr.write("resultar-lint is deprecated. Use resultar-check instead.\n");

const [command, ...rest] = process.argv.slice(2);
const forwardedArgs = command === "check" ? rest : process.argv.slice(2);

process.exitCode = resultarCheck.runResultarCheckCli(forwardedArgs);

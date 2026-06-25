#!/usr/bin/env node
import { createRequire } from "node:module";

interface ResultarCheckPlugin {
  readonly runResultarCheckCli: (args?: readonly string[]) => number;
}

const requirePackage = createRequire(import.meta.url);
const resultarCheck = requirePackage("resultar-check") as ResultarCheckPlugin;

process.exitCode = resultarCheck.runResultarCheckCli(process.argv.slice(2));

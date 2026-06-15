#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const requireFromHere = createRequire(import.meta.url);
const requireFromCwd = createRequire(join(process.cwd(), "package.json"));

const resolvePackage = (specifier: string): string => {
  try {
    return requireFromCwd.resolve(specifier);
  } catch {
    return requireFromHere.resolve(specifier);
  }
};

const nativePackageJson = resolvePackage("@typescript/native-preview/package.json");
const nativeTsgoBin = join(dirname(nativePackageJson), "bin/tsgo.js");
const resultarLintBin = join(dirname(resolvePackage("resultar-lint")), "cli.js");

const passthroughArgs = new Set(["--help", "-h", "--version", "-v"]);

const shouldSkipNoDiscard = (args: readonly string[]): boolean =>
  args.some((arg) => passthroughArgs.has(arg));

const getProjectArg = (args: readonly string[]): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--project" || arg === "-p") {
      return args[index + 1];
    }

    if (arg !== undefined && arg.startsWith("--project=")) {
      return arg.slice("--project=".length);
    }
  }

  return undefined;
};

const runNode = (script: string, args: readonly string[]): number => {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });

  if (result.error !== undefined) {
    throw result.error;
  }

  return result.status ?? 1;
};

const args = process.argv.slice(2);
const tsgoStatus = runNode(nativeTsgoBin, args);

if (tsgoStatus !== 0 || shouldSkipNoDiscard(args)) {
  process.exitCode = tsgoStatus;
} else {
  const project = getProjectArg(args);
  process.exitCode = runNode(
    resultarLintBin,
    project === undefined ? ["check"] : ["check", "--project", project],
  );
}

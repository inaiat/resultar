#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { runDoctor, runInit } from "./setup.js";

interface NativeTarget {
  readonly packageName: string;
}

interface PackageManifest {
  readonly version?: string;
}

const isPackageManifest = (value: unknown): value is PackageManifest =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  (value.version === undefined || typeof value.version === "string");

const targetByPlatform: Readonly<Record<string, NativeTarget>> = {
  "darwin-arm64": { packageName: "resultar-check-darwin-arm64" },
  "darwin-x64": { packageName: "resultar-check-darwin-x64" },
  "linux-arm64": { packageName: "resultar-check-linux-arm64" },
  "linux-x64": { packageName: "resultar-check-linux-x64" },
  "win32-arm64": { packageName: "resultar-check-win32-arm64" },
  "win32-x64": { packageName: "resultar-check-win32-x64" },
};

const require = createRequire(import.meta.url);

const resolveExecutable = (packageName: string): string | undefined => {
  try {
    return require.resolve(packageName);
  } catch {
    return undefined;
  }
};

const packageVersion = (): string => {
  try {
    const manifest: unknown = require("../package.json");
    return isPackageManifest(manifest) ? (manifest.version ?? "unknown") : "unknown";
  } catch {
    return "unknown";
  }
};

const run = (args: readonly string[] = process.argv.slice(2)): number => {
  if (args[0] === "init") {
    return runInit(args.slice(1));
  }

  if (args[0] === "doctor") {
    return runDoctor(args.slice(1));
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  const targetName = `${process.platform}-${process.arch}`;
  const target = targetByPlatform[targetName];

  if (target === undefined) {
    process.stderr.write(
      `resultar-check does not provide a native binary for ${process.platform}/${process.arch}.\n`,
    );
    return 1;
  }

  const executable = resolveExecutable(target.packageName);

  if (executable === undefined) {
    process.stderr.write(
      [
        `Missing optional native package ${target.packageName}.`,
        "Reinstall resultar-check without disabling optional dependencies.",
        "The TypeScript fallback has been removed.",
        "",
      ].join("\n"),
    );
    return 1;
  }

  const result = spawnSync(executable, args, { stdio: "inherit" });

  if (result.error !== undefined) {
    process.stderr.write(`Unable to execute ${target.packageName}: ${result.error.message}\n`);
    return 1;
  }

  return result.status ?? 1;
};

try {
  process.exitCode = run();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

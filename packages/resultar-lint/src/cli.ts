#!/usr/bin/env node
import {
  type TypeScriptPatchResult,
  getTypeScriptPatchStatus,
  patchTypeScriptPackage,
  unpatchTypeScriptPackage,
} from "./patch.js";
import { runResultarLintCli } from "./lint.js";

type Command = "check" | "doctor" | "help" | "patch" | "unpatch";
type PatchResultVerb = "checked" | "patched" | "unpatched";

interface CliOptions {
  readonly command: Command;
  readonly args?: readonly string[];
  readonly dir?: string;
}

const usage = `Usage: resultar-lint <command> [flags]

Commands:
  check    Run Resultar lint diagnostics for a TypeScript project.
  patch    Patch local TypeScript so tsc emits Resultar diagnostics.
  unpatch  Remove Resultar patch blocks from local TypeScript.
  doctor   Check whether local TypeScript is patched.
  help     Show this help message.

Check flags:
  -p, --project <path>     TypeScript project file to inspect. Defaults to tsconfig.json.
  --mode <direct|must-use> Check mode. Defaults to tsconfig plugin noDiscardMode or must-use.

Patch flags:
  -d, --dir <path>  TypeScript package directory. Defaults to the local installed typescript package.
`;

const parseArgs = (args: readonly string[]): CliOptions => {
  const [commandArg, ...rest] = args;
  const command = commandArg === "--help" || commandArg === "-h" ? "help" : (commandArg ?? "help");

  if (!["check", "doctor", "help", "patch", "unpatch"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  if (command === "check") {
    return { args: rest, command };
  }

  let dir: string | undefined = undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (arg === "--dir" || arg === "-d") {
      const nextArg = rest[index + 1];

      if (nextArg === undefined || nextArg === "") {
        throw new Error(`${arg} requires a path`);
      }

      dir = nextArg;
      index += 1;
    } else if (arg !== undefined && arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg !== undefined) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return dir === undefined ? { command: command as Command } : { command: command as Command, dir };
};

const printPatchResult = (verb: PatchResultVerb, result: TypeScriptPatchResult): void => {
  process.stdout.write(`TypeScript ${result.typescriptVersion}\n`);

  for (const moduleStatus of result.modules) {
    let status = verb === "checked" ? "not patched" : "unchanged";

    if (moduleStatus.changed) {
      status = verb;
    } else if (moduleStatus.patched) {
      status = verb === "checked" ? "patched" : "already patched";
    }

    process.stdout.write(`${moduleStatus.file}: ${status}\n`);
  }
};

const run = async (args: readonly string[] = process.argv.slice(2)): Promise<number> => {
  const options = parseArgs(args);

  if (options.command === "help") {
    process.stdout.write(usage);
    return 0;
  }

  if (options.command === "patch") {
    printPatchResult("patched", await patchTypeScriptPackage({ dir: options.dir }));
    return 0;
  }

  if (options.command === "unpatch") {
    printPatchResult("unpatched", await unpatchTypeScriptPackage({ dir: options.dir }));
    return 0;
  }

  if (options.command === "check") {
    return runResultarLintCli(options.args ?? []);
  }

  const result = await getTypeScriptPatchStatus({ dir: options.dir });
  printPatchResult("checked", result);

  return result.modules.every((moduleStatus) => moduleStatus.patched) ? 0 : 1;
};

void (async () => {
  try {
    process.exitCode = await run();
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
})();

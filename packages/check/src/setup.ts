import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseOptions = (
  args: readonly string[],
): { readonly force: boolean; readonly project: string } => {
  let force = false;
  let project = "tsconfig.json";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--force" || argument === "-f") {
      force = true;
      continue;
    }
    if (argument === "--project" || argument === "-p") {
      const value = args[index + 1];
      if (value === undefined) {
        // resultar-check-disable-next-line prefer-tagged-error
        throw new Error("Missing value for --project");
      }
      project = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--project=")) {
      project = argument.slice("--project=".length);
      continue;
    }
    // resultar-check-disable-next-line prefer-tagged-error
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { force, project };
};

const setupUsage = `Usage: resultar-check <init|doctor> [options]

Commands:
  init                         Create the portable Zed LSP setup.
  doctor                       Check the project, binary, pnpm, and Zed setup.

Options:
  -p, --project <path>         TypeScript project (default: tsconfig.json).
  -f, --force                  Refresh .zed/settings.json while preserving other settings.
`;

const projectPathFrom = (root: string, project: string): string =>
  resolve(root, isAbsolute(project) ? project : project);

const zedProjectPath = (root: string, projectPath: string): string => {
  const projectRelative = relative(root, projectPath);
  if (
    projectRelative === "" ||
    projectRelative.startsWith(`..${sep}`) ||
    isAbsolute(projectRelative)
  ) {
    return projectPath.replaceAll(sep, "/");
  }
  return projectRelative.replaceAll(sep, "/");
};

const generatedSettings = (project: string): JsonRecord => ({
  lsp: {
    "typescript-language-server": {
      binary: { arguments: ["exec", "resultar-check", "lsp", "--project", project], path: "pnpm" },
    },
  },
  languages: {
    TSX: { language_servers: ["vtsls", "typescript-language-server", "..."] },
    TypeScript: { language_servers: ["vtsls", "typescript-language-server", "..."] },
  },
});

const readJsonRecord = (filePath: string): JsonRecord => {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) {
    // resultar-check-disable-next-line prefer-tagged-error
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
};

const mergeSettings = (existing: JsonRecord, generated: JsonRecord): JsonRecord => {
  const merged: JsonRecord = { ...existing };
  for (const key of ["lsp", "languages"]) {
    const generatedValue = generated[key];
    if (!isRecord(generatedValue)) {
      continue;
    }
    const existingValue = isRecord(existing[key]) ? existing[key] : {};
    const section: JsonRecord = { ...existingValue };
    for (const [entryKey, entryValue] of Object.entries(generatedValue)) {
      const previous = existingValue[entryKey];
      section[entryKey] =
        isRecord(previous) && isRecord(entryValue) ? { ...previous, ...entryValue } : entryValue;
    }
    merged[key] = section;
  }
  return merged;
};

const writeZedSettings = (root: string, project: string, force: boolean): string => {
  const zedDirectory = join(root, ".zed");
  const settingsPath = join(zedDirectory, "settings.json");
  const generated = generatedSettings(project);
  mkdirSync(zedDirectory, { recursive: true });
  let settings = generated;
  if (existsSync(settingsPath)) {
    if (!force) {
      return settingsPath;
    }
    settings = mergeSettings(readJsonRecord(settingsPath), generated);
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, undefined, 2)}\n`, "utf8");
  return settingsPath;
};

export const runInit = (args: readonly string[]): number => {
  try {
    if (args.includes("--help") || args.includes("-h")) {
      process.stdout.write(setupUsage);
      return 0;
    }
    const options = parseOptions(args);
    const root = process.cwd();
    const projectPath = projectPathFrom(root, options.project);
    if (!existsSync(projectPath)) {
      // resultar-check-disable-next-line prefer-tagged-error
      throw new Error(`TypeScript project not found: ${projectPath}`);
    }
    const project = zedProjectPath(root, projectPath);
    const settingsPath = join(root, ".zed", "settings.json");
    const existed = existsSync(settingsPath);
    writeZedSettings(root, project, options.force);
    let action = "created";
    if (!options.force && existed) {
      action = "already exists";
    } else if (options.force && existed) {
      action = "updated";
    }
    process.stdout.write(
      `resultar-check: Zed setup ${action} at ${settingsPath}\n` +
        `  LSP command: pnpm exec resultar-check lsp --project ${project}\n`,
    );
    if (!options.force && existed) {
      process.stdout.write(
        "  Use --force to refresh the Resultar LSP entry while preserving other settings.\n",
      );
    }
    return 0;
  } catch (error: unknown) {
    process.stderr.write(
      `resultar-check init: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
};

const check = (label: string, passed: boolean, detail: string): boolean => {
  process.stdout.write(`${passed ? "✓" : "✗"} ${label}: ${detail}\n`);
  return passed;
};

const executableAvailable = (filePath: string): boolean => {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const runDoctor = (args: readonly string[]): number => {
  try {
    if (args.includes("--help") || args.includes("-h")) {
      process.stdout.write(setupUsage);
      return 0;
    }
    const options = parseOptions(args);
    const root = process.cwd();
    const projectPath = projectPathFrom(root, options.project);
    const settingsPath = join(root, ".zed", "settings.json");
    let healthy = true;
    healthy = check("project", existsSync(projectPath), projectPath) && healthy;

    const localBinary = join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "resultar-check.cmd" : "resultar-check",
    );
    const binaryHealthy =
      existsSync(localBinary) && (process.platform === "win32" || executableAvailable(localBinary));
    healthy =
      check(
        "resultar-check binary",
        binaryHealthy,
        binaryHealthy ? localBinary : "missing; run pnpm install",
      ) && healthy;

    const pnpm = spawnSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" });
    const pnpmHealthy = pnpm.status === 0;
    healthy =
      check("pnpm", pnpmHealthy, pnpmHealthy ? pnpm.stdout.trim() : "not found on PATH") && healthy;

    let settings: JsonRecord | undefined = undefined;
    if (existsSync(settingsPath)) {
      try {
        settings = readJsonRecord(settingsPath);
      } catch (error: unknown) {
        healthy =
          check("Zed settings", false, error instanceof Error ? error.message : String(error)) &&
          healthy;
      }
    } else {
      healthy =
        check("Zed settings", false, `${settingsPath} is missing; run resultar-check init`) &&
        healthy;
    }
    if (settings !== undefined) {
      const lsp = isRecord(settings.lsp) ? settings.lsp["typescript-language-server"] : undefined;
      const binary = isRecord(lsp) && isRecord(lsp.binary) ? lsp.binary : undefined;
      const path = binary?.path;
      const binaryArguments = binary?.arguments;
      const configured =
        path === "pnpm" &&
        Array.isArray(binaryArguments) &&
        binaryArguments[0] === "exec" &&
        binaryArguments[1] === "resultar-check";
      healthy =
        check(
          "Zed LSP",
          configured,
          configured ? "pnpm exec resultar-check lsp" : "run resultar-check init --force",
        ) && healthy;
    }

    if (pnpmHealthy && binaryHealthy) {
      const version = spawnSync("pnpm", ["exec", "resultar-check", "--version"], {
        cwd: root,
        encoding: "utf8",
      });
      const versionHealthy = version.status === 0 && version.stdout.trim().length > 0;
      healthy =
        check(
          "launcher",
          versionHealthy,
          versionHealthy
            ? `version ${version.stdout.trim()}`
            : version.stderr || "failed to execute",
        ) && healthy;
    }
    return healthy ? 0 : 1;
  } catch (error: unknown) {
    process.stderr.write(
      `resultar-check doctor: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
};

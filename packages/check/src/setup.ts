import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type JsonRecord = Record<string, unknown>;
export type EditorTarget = "zed" | "vscode" | "cursor" | "all";

interface SetupOptions {
  readonly editor: EditorTarget;
  readonly force: boolean;
  readonly project: string;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseEditor = (value: string): EditorTarget => {
  switch (value) {
    case "zed":
    case "vscode":
    case "cursor":
    case "all": {
      return value;
    }
    default: {
      // resultar-check-disable-next-line prefer-tagged-error
      throw new Error(`Unknown --editor value: ${value} (expected zed, vscode, cursor, or all)`);
    }
  }
};

const parseOptions = (args: readonly string[]): SetupOptions => {
  let editor: EditorTarget = "zed";
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
    if (argument === "--editor" || argument === "-e") {
      const value = args[index + 1];
      if (value === undefined) {
        // resultar-check-disable-next-line prefer-tagged-error
        throw new Error("Missing value for --editor");
      }
      editor = parseEditor(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--editor=")) {
      editor = parseEditor(argument.slice("--editor=".length));
      continue;
    }
    // resultar-check-disable-next-line prefer-tagged-error
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { editor, force, project };
};

const setupUsage = `Usage: resultar-check <init|doctor> [options]

Commands:
  init                         Create editor setup for Zed, VS Code, Cursor, or all.
  doctor                       Check the project, binary, pnpm, and editor setup.

Options:
  -e, --editor <target>        Target editor: zed (default), vscode, cursor, or all.
  -p, --project <path>         TypeScript project (default: tsconfig.json).
  -f, --force                  Refresh generated entries while preserving other settings.
`;

const projectPathFrom = (root: string, project: string): string =>
  resolve(root, isAbsolute(project) ? project : project);

const normalizedProjectPath = (root: string, projectPath: string): string => {
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

const generatedZedSettings = (project: string): JsonRecord => ({
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

const RESULTAR_PROBLEM_MATCHER: JsonRecord = {
  owner: "resultar-check",
  // eslint-disable-next-line no-template-curly-in-string
  fileLocation: ["relative", "${workspaceFolder}"],
  pattern: {
    regexp: String.raw`^(.+):(\d+):(\d+) resultar/([a-z0-9-]+) \((error|warning|suggestion|message)\) - (.+)$`,
    file: 1,
    line: 2,
    column: 3,
    code: 4,
    severity: 5,
    message: 6,
  },
};

const generatedVscodeTasks = (project: string): readonly JsonRecord[] => [
  {
    label: "resultar-check",
    type: "shell",
    command: "pnpm",
    args: ["exec", "resultar-check", "--project", project],
    group: "test",
    presentation: { reveal: "silent", panel: "dedicated", clear: true },
    problemMatcher: RESULTAR_PROBLEM_MATCHER,
  },
  {
    label: "resultar-check: fix",
    type: "shell",
    command: "pnpm",
    args: ["exec", "resultar-check", "--fix", "--project", project],
    presentation: { reveal: "always", panel: "dedicated", clear: true },
    problemMatcher: RESULTAR_PROBLEM_MATCHER,
  },
];

const generatedCursorRule = (project: string): string =>
  [
    "---",
    "description: Run resultar-check static diagnostics on Resultar TypeScript code",
    "globs:",
    '  - "**/*.ts"',
    '  - "**/*.tsx"',
    "alwaysApply: false",
    "---",
    "",
    "# Resultar diagnostics",
    "",
    `Run \`pnpm exec resultar-check --project ${project}\` after editing TypeScript files that use \`resultar\`, \`resultar-di\`, or \`resultar-app\`.`,
    `Use \`pnpm exec resultar-check --fix --project ${project}\` to apply safe correction fixes automatically.`,
    "Never auto-silence `no-discard` diagnostics with `void` unless discarding the result is explicitly intentional.",
    "",
  ].join("\n");

const readJsonRecord = (filePath: string): JsonRecord => {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) {
    // resultar-check-disable-next-line prefer-tagged-error
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
};

const mergeZedSettings = (existing: JsonRecord, generated: JsonRecord): JsonRecord => {
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

const mergeVscodeTasks = (existing: JsonRecord, tasks: readonly JsonRecord[]): JsonRecord => {
  const existingTasks: readonly unknown[] = Array.isArray(existing.tasks) ? existing.tasks : [];
  const managedLabels = new Set(
    tasks.map((task) => (typeof task.label === "string" ? task.label : "")),
  );
  const preserved: unknown[] = existingTasks.filter(
    (entry) =>
      !(isRecord(entry) && typeof entry.label === "string" && managedLabels.has(entry.label)),
  );
  return {
    version: typeof existing.version === "string" ? existing.version : "2.0.0",
    ...existing,
    tasks: [...preserved, ...tasks],
  };
};

type WriteAction = "created" | "updated" | "already exists";

const resolveAction = (existed: boolean, force: boolean): WriteAction => {
  if (!existed) {
    return "created";
  }
  return force ? "updated" : "already exists";
};

const writeZedSetup = (root: string, project: string, force: boolean): WriteAction => {
  const zedDirectory = join(root, ".zed");
  const settingsPath = join(zedDirectory, "settings.json");
  const existed = existsSync(settingsPath);
  const generated = generatedZedSettings(project);
  mkdirSync(zedDirectory, { recursive: true });
  let settings = generated;
  if (existed) {
    if (!force) {
      return "already exists";
    }
    settings = mergeZedSettings(readJsonRecord(settingsPath), generated);
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, undefined, 2)}\n`, "utf8");
  return resolveAction(existed, force);
};

const VSCODE_EXTENSION_ID = "inaiat.resultar-check";

const mergeVscodeExtensions = (existing: JsonRecord): JsonRecord => {
  const existingRecs: readonly unknown[] = Array.isArray(existing.recommendations)
    ? existing.recommendations
    : [];
  const hasExtension = existingRecs.includes(VSCODE_EXTENSION_ID);
  return {
    ...existing,
    recommendations: hasExtension ? [...existingRecs] : [...existingRecs, VSCODE_EXTENSION_ID],
  };
};

const writeVscodeExtensions = (root: string, force: boolean): WriteAction => {
  const vscodeDirectory = join(root, ".vscode");
  const extensionsPath = join(vscodeDirectory, "extensions.json");
  const existed = existsSync(extensionsPath);
  mkdirSync(vscodeDirectory, { recursive: true });
  let payload: JsonRecord = { recommendations: [VSCODE_EXTENSION_ID] };
  if (existed) {
    if (!force) {
      return "already exists";
    }
    payload = mergeVscodeExtensions(readJsonRecord(extensionsPath));
  }
  writeFileSync(extensionsPath, `${JSON.stringify(payload, undefined, 2)}\n`, "utf8");
  return resolveAction(existed, force);
};

const writeVscodeTasks = (root: string, project: string, force: boolean): WriteAction => {
  const vscodeDirectory = join(root, ".vscode");
  const tasksPath = join(vscodeDirectory, "tasks.json");
  const existed = existsSync(tasksPath);
  const tasks = generatedVscodeTasks(project);
  mkdirSync(vscodeDirectory, { recursive: true });
  let payload: JsonRecord = { version: "2.0.0", tasks };
  if (existed) {
    if (!force) {
      return "already exists";
    }
    payload = mergeVscodeTasks(readJsonRecord(tasksPath), tasks);
  }
  writeFileSync(tasksPath, `${JSON.stringify(payload, undefined, 2)}\n`, "utf8");
  return resolveAction(existed, force);
};

const writeCursorRule = (root: string, project: string, force: boolean): WriteAction => {
  const rulesDirectory = join(root, ".cursor", "rules");
  const rulePath = join(rulesDirectory, "resultar-check.mdc");
  const existed = existsSync(rulePath);
  if (existed && !force) {
    return "already exists";
  }
  mkdirSync(rulesDirectory, { recursive: true });
  writeFileSync(rulePath, generatedCursorRule(project), "utf8");
  return resolveAction(existed, force);
};

const includesZed = (editor: EditorTarget): boolean => editor === "zed" || editor === "all";
const includesVscodeTasks = (editor: EditorTarget): boolean =>
  editor === "vscode" || editor === "cursor" || editor === "all";
const includesCursor = (editor: EditorTarget): boolean => editor === "cursor" || editor === "all";

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
    const project = normalizedProjectPath(root, projectPath);
    let sawExisting = false;

    if (includesZed(options.editor)) {
      const settingsPath = join(root, ".zed", "settings.json");
      const action = writeZedSetup(root, project, options.force);
      sawExisting ||= action === "already exists";
      process.stdout.write(
        `resultar-check: Zed setup ${action} at ${settingsPath}\n` +
          `  LSP command: pnpm exec resultar-check lsp --project ${project}\n`,
      );
    }

    if (includesVscodeTasks(options.editor)) {
      const tasksPath = join(root, ".vscode", "tasks.json");
      const action = writeVscodeTasks(root, project, options.force);
      sawExisting ||= action === "already exists";
      const label = options.editor === "cursor" ? "VS Code/Cursor" : "VS Code";
      process.stdout.write(
        `resultar-check: ${label} tasks ${action} at ${tasksPath}\n` +
          `  Tasks: "resultar-check" and "resultar-check: fix" (project: ${project})\n`,
      );
      const extensionsPath = join(root, ".vscode", "extensions.json");
      const extAction = writeVscodeExtensions(root, options.force);
      sawExisting ||= extAction === "already exists";
      process.stdout.write(
        `resultar-check: ${label} extension recommendation ${extAction} at ${extensionsPath} (${VSCODE_EXTENSION_ID})\n`,
      );
    }

    if (includesCursor(options.editor)) {
      const rulePath = join(root, ".cursor", "rules", "resultar-check.mdc");
      const action = writeCursorRule(root, project, options.force);
      sawExisting ||= action === "already exists";
      process.stdout.write(`resultar-check: Cursor rule ${action} at ${rulePath}\n`);
    }

    if (!options.force && sawExisting) {
      process.stdout.write(
        "  Use --force to refresh the generated Resultar entries while preserving other settings.\n",
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

const checkZedSetup = (root: string): boolean => {
  const settingsPath = join(root, ".zed", "settings.json");
  if (!existsSync(settingsPath)) {
    return check(
      "Zed settings",
      false,
      `${settingsPath} is missing; run resultar-check init --editor zed`,
    );
  }
  let settings: JsonRecord | undefined = undefined;
  try {
    settings = readJsonRecord(settingsPath);
  } catch (error: unknown) {
    return check("Zed settings", false, error instanceof Error ? error.message : String(error));
  }
  const lsp = isRecord(settings.lsp) ? settings.lsp["typescript-language-server"] : undefined;
  const binary = isRecord(lsp) && isRecord(lsp.binary) ? lsp.binary : undefined;
  const path = binary?.path;
  const binaryArguments = binary?.arguments;
  const configured =
    path === "pnpm" &&
    Array.isArray(binaryArguments) &&
    binaryArguments[0] === "exec" &&
    binaryArguments[1] === "resultar-check";
  return check(
    "Zed LSP",
    configured,
    configured ? "pnpm exec resultar-check lsp" : "run resultar-check init --editor zed --force",
  );
};

const hasResultarTask = (tasks: unknown): boolean => {
  if (!Array.isArray(tasks)) {
    return false;
  }
  return tasks.some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const args = Array.isArray(entry.args) ? entry.args : [];
    const command = typeof entry.command === "string" ? entry.command : "";
    return (
      entry.label === "resultar-check" &&
      (command.includes("resultar-check") ||
        args.some((item) => typeof item === "string" && item.includes("resultar-check")))
    );
  });
};

const checkVscodeTasks = (root: string, editor: EditorTarget): boolean => {
  const tasksPath = join(root, ".vscode", "tasks.json");
  const hint = `run resultar-check init --editor ${editor === "all" ? "all" : editor}`;
  if (!existsSync(tasksPath)) {
    return check("VS Code tasks", false, `${tasksPath} is missing; ${hint}`);
  }
  let tasksFile: JsonRecord | undefined = undefined;
  try {
    tasksFile = readJsonRecord(tasksPath);
  } catch (error: unknown) {
    return check("VS Code tasks", false, error instanceof Error ? error.message : String(error));
  }
  const configured = hasResultarTask(tasksFile.tasks);
  return check(
    "VS Code tasks",
    configured,
    configured ? tasksPath : `missing resultar-check task; ${hint} --force`,
  );
};

const checkCursorRule = (root: string): boolean => {
  const rulePath = join(root, ".cursor", "rules", "resultar-check.mdc");
  const exists = existsSync(rulePath);
  return check(
    "Cursor rule",
    exists,
    exists ? rulePath : `${rulePath} is missing; run resultar-check init --editor cursor`,
  );
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

    if (includesZed(options.editor)) {
      healthy = checkZedSetup(root) && healthy;
    }
    if (includesVscodeTasks(options.editor)) {
      healthy = checkVscodeTasks(root, options.editor) && healthy;
    }
    if (includesCursor(options.editor)) {
      healthy = checkCursorRule(root) && healthy;
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

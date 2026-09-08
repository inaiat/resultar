import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ResultTask } from "resultar";

import { createModule, resource, service } from "../dist/index.js";

type PackFile = Readonly<{ path: string }>;
type PackManifest = Readonly<{ files: readonly PackFile[] }>;

const rootDir = process.cwd();
const requiredFiles = [
  "LICENSE",
  "README.md",
  "ADVANCED.md",
  "dist/advanced.js",
  "dist/advanced.d.ts",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
] as const;
const expectedExports = ["Service", "createModule", "resource", "service"] as const;

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const isPackFile = (value: unknown): value is PackFile =>
  isRecord(value) && typeof value.path === "string";

const isPackManifest = (value: unknown): value is PackManifest =>
  isRecord(value) && Array.isArray(value.files) && value.files.every(isPackFile);

const parseJsonArrayFromNpmOutput = (packOutput: string): unknown => {
  const trimmed = packOutput.trim();
  let index = trimmed.indexOf("[");

  while (index >= 0) {
    try {
      return JSON.parse(trimmed.slice(index)) as unknown;
    } catch {
      index = trimmed.indexOf("[", index + 1);
    }
  }

  throw new TypeError("npm pack did not include JSON output");
};

const parsePackedFiles = (packOutput: string): readonly string[] => {
  const parsed = parseJsonArrayFromNpmOutput(packOutput);

  if (!Array.isArray(parsed) || !isPackManifest(parsed[0])) {
    throw new TypeError("npm pack returned an unexpected manifest shape");
  }

  return parsed[0].files.map((file) => file.path);
};

for (const file of requiredFiles) {
  if (!existsSync(join(rootDir, file))) {
    throw new Error(`Missing package smoke file: ${file}`);
  }
}

const entrypoint = (await import(pathToFileURL(join(rootDir, "dist/index.js")).href)) as Record<
  string,
  unknown
>;
const actualExports = Object.keys(entrypoint).toSorted();

if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports)) {
  throw new Error(
    `Unexpected public exports:\nactual: ${actualExports.join(", ")}\nexpected: ${expectedExports.join(", ")}`,
  );
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});
const packedFiles = parsePackedFiles(packOutput).toSorted();

for (const file of requiredFiles) {
  if (!packedFiles.includes(file)) {
    throw new Error(`Packed package is missing required file: ${file}`);
  }
}

const allowedPackedFile =
  /^(?:LICENSE|README\.md|ADVANCED\.md|package\.json|dist\/[^/]+\.(?:js|d\.ts|js\.map))$/u;
const unexpectedFiles = packedFiles.filter((file) => !allowedPackedFile.test(file));

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed package contains unexpected files:\n${unexpectedFiles.join("\n")}`);
}

const events: string[] = [];
const Database = resource("database", {
  acquire: ResultTask.sync(() => {
    events.push("open");
    return { status: "live" };
  }),
  release: () =>
    ResultTask.sync(() => {
      events.push("close");
    }),
});
const Health = service("health", { database: Database }, ({ database }) => database.status);
const services = createModule().scoped(Database).scoped(Health);
const value = await ResultTask.runPromise(
  services.use(["health"], ({ health }) => ResultTask.succeed(health)),
);
if (value !== "live" || events.join(",") !== "open,close") {
  throw new Error("Published entrypoint did not preserve resource lifetime");
}
const mocked = await ResultTask.runPromise(
  services
    .override("database", { status: "mock" })
    .use(["health"], ({ health }) => ResultTask.succeed(health)),
);
if (mocked !== "mock" || events.join(",") !== "open,close") {
  throw new Error("Published entrypoint did not preserve override isolation");
}

process.stdout.write(
  `Package smoke passed with ${packedFiles.length} packed files and scoped composition.\n`,
);

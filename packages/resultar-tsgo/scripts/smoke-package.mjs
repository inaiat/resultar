import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

const requiredFiles = ["LICENSE", "README.md", "dist/cli.d.ts", "dist/cli.js", "package.json"];

const isRecord = (value) => typeof value === "object" && value !== null;

const parseJsonArrayFromNpmOutput = (packOutput) => {
  const trimmed = packOutput.trim();
  let index = trimmed.indexOf("[");

  while (index >= 0) {
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      index = trimmed.indexOf("[", index + 1);
    }
  }

  throw new TypeError("npm pack did not include JSON output");
};

const parsePackedFiles = (packOutput) => {
  const parsed = parseJsonArrayFromNpmOutput(packOutput);
  const firstManifest = parsed[0];

  if (!Array.isArray(parsed) || !isRecord(firstManifest) || !Array.isArray(firstManifest.files)) {
    throw new TypeError("npm pack returned an unexpected manifest shape");
  }

  return firstManifest.files.map((file) => {
    if (!isRecord(file) || typeof file.path !== "string") {
      throw new TypeError("npm pack returned an unexpected file shape");
    }

    return file.path;
  });
};

for (const file of requiredFiles) {
  if (!existsSync(join(rootDir, file))) {
    throw new Error(`Missing tsgo package smoke file: ${file}`);
  }
}

const versionOutput = execFileSync(process.execPath, [join(rootDir, "dist/cli.js"), "--version"], {
  cwd: rootDir,
  encoding: "utf8",
});

if (!versionOutput.includes("Version ")) {
  throw new Error("TSGo wrapper version output is missing expected TypeScript version text");
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});
const packedFiles = parsePackedFiles(packOutput).toSorted();

for (const file of requiredFiles) {
  if (!packedFiles.includes(file)) {
    throw new Error(`Packed tsgo package is missing required file: ${file}`);
  }
}

const allowedPackedFile = /^(?:LICENSE|README\.md|package\.json|dist\/cli\.(?:js|d\.ts))$/;
const unexpectedFiles = packedFiles.filter((file) => !allowedPackedFile.test(file));

if (unexpectedFiles.length > 0) {
  throw new Error(`Packed tsgo package contains unexpected files:\n${unexpectedFiles.join("\n")}`);
}

process.stdout.write(`TSGo package smoke passed with ${packedFiles.length} packed files.\n`);

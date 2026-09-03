import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const checkDir = dirname(import.meta.dirname);
const nativeDir = join(checkDir, "native");
const nativePackagesDir = join(checkDir, "native-packages");

const targets = [
  { arch: "arm64", goarch: "arm64", goos: "darwin", platform: "darwin" },
  { arch: "x64", goarch: "amd64", goos: "darwin", platform: "darwin" },
  { arch: "arm64", goarch: "arm64", goos: "linux", platform: "linux" },
  { arch: "x64", goarch: "amd64", goos: "linux", platform: "linux" },
  { arch: "arm64", goarch: "arm64", goos: "windows", platform: "win32" },
  { arch: "x64", goarch: "amd64", goos: "windows", platform: "win32" },
];

const [mode] = process.argv.slice(2);

if (mode !== "--all" && mode !== "--current") {
  throw new Error("Usage: build-native-binaries.ts <--all|--current>");
}

const selectedTargets =
  mode === "--all"
    ? targets
    : targets.filter(
        (target) => target.platform === process.platform && target.arch === process.arch,
      );

if (selectedTargets.length === 0) {
  throw new Error(`Unsupported native target ${process.platform}/${process.arch}`);
}

for (const target of selectedTargets) {
  const packageName = `resultar-check-${target.platform}-${target.arch}`;
  const packageDirectory = packageName.replace(/^resultar-check-/u, "");
  const executableName = target.goos === "windows" ? "resultar-check.exe" : "resultar-check";
  const output = join(nativePackagesDir, packageDirectory, "bin", executableName);

  mkdirSync(dirname(output), { recursive: true });

  const result = spawnSync(
    "go",
    ["-C", nativeDir, "build", "-trimpath", "-ldflags=-s -w", "-o", output, "./cmd/resultar-check"],
    {
      env: { ...process.env, CGO_ENABLED: "0", GOARCH: target.goarch, GOOS: target.goos },
      stdio: "inherit",
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Go build failed for ${target.platform}/${target.arch}`);
  }

  process.stdout.write(`Built ${packageName}/bin/${executableName}\n`);
}

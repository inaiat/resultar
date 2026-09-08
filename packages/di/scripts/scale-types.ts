import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "resultar-di-scale-"));
try {
  for (const [size, deep] of [
    [50, false],
    [100, false],
    [200, false],
    [12, true],
  ] as const) {
    const lines = [
      `import { createModule, service } from ${JSON.stringify(resolve(root, "dist/index.js"))};`,
      `import { ResultTask } from ${JSON.stringify(resolve(root, "../resultar/dist/index.js"))};`,
      "const m0 = createModule();",
    ];
    for (let i = 0; i < size; i += 1) {
      const args =
        deep && i > 0 ? `{ previous: s${i - 1} }, ({ previous }) => previous + 1` : "{}, () => 1";
      lines.push(
        `const s${i} = service("s${i}", ${args});`,
        `const m${i + 1} = m${i}.singleton(s${i});`,
      );
    }
    lines.push(
      `const program: ResultTask<number> = m${size}.use(["s${size - 1}"], (services) => ResultTask.succeed(services.s${size - 1}));`,
      "void program;",
    );
    const file = join(directory, `graph-${size}-${deep}.mts`);
    writeFileSync(file, lines.join("\n"));
    const started = performance.now();
    const output = execFileSync(
      resolve(root, "node_modules/.bin/tsc"),
      [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ESNext",
        "--module",
        "NodeNext",
        "--extendedDiagnostics",
        file,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    const metrics = output
      .split("\n")
      .filter((line) => /Check time|Total time|Memory used|Instantiations/u.test(line));
    const wallMs = Math.round(performance.now() - started);
    process.stdout.write(
      JSON.stringify({
        services: size,
        topology: deep ? "chain" : "independent",
        wallMs,
        metrics,
      }) + "\n",
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

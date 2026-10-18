import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "resultar-di-scale-"));
try {
  for (const [size, deep, style] of [
    [50, false, "service"],
    [100, false, "service"],
    [200, false, "service"],
    [12, true, "service"],
    [50, false, "requires"],
    [100, false, "requires"],
    [200, false, "requires"],
    [12, true, "requires"],
    [50, false, "sync-requires"],
    [100, false, "sync-requires"],
    [200, false, "sync-requires"],
    [12, true, "sync-requires"],
  ] as const) {
    const lines = [
      `import { createModule, service, Service } from ${JSON.stringify(resolve(root, "dist/index.js"))};`,
      `import { ResultTask } from ${JSON.stringify(resolve(root, "../resultar/dist/index.js"))};`,
      "const m0 = createModule();",
    ];
    for (let i = 0; i < size; i += 1) {
      const args =
        deep && i > 0 ? `{ previous: s${i - 1} }, ({ previous }) => previous + 1` : "{}, () => 1";
      const value = deep && i > 0 ? "previous + 1" : "1";
      const construction = style === "sync-requires" ? value : `ResultTask.succeed(${value})`;
      const required =
        deep && i > 0
          ? `{ requires: { previous: s${i - 1} }, make: ({ previous }) => ${construction} }`
          : `{ requires: {}, make: () => ${construction} }`;
      const declaration =
        style === "service"
          ? `const s${i} = service("s${i}", ${args});`
          : `class s${i} extends Service("s${i}", ${required}) {}`;
      lines.push(declaration, `const m${i + 1} = m${i}.singleton(s${i});`);
    }
    lines.push(
      `const program: ResultTask<number> = m${size}.use(["s${size - 1}"], (services) => ResultTask.succeed(services.s${size - 1}));`,
      "void program;",
    );
    const file = join(directory, `graph-${style}-${size}-${deep}.mts`);
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
        style,
        topology: deep ? "chain" : "independent",
        wallMs,
        metrics,
      }) + "\n",
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

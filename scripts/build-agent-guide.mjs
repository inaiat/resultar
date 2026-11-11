import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const core = join(root, "packages/resultar");
const target = join(core, "dist/agent");
const skill = join(root, "skills/resultar");
mkdirSync(target, { recursive: true });
for (const name of ["SKILL.md", "references", "agents", "examples"]) {
  cpSync(join(skill, name), join(target, name), { recursive: true });
}
// Keep one authored manual, bundled with the release instead of requiring web access.
const manuals = ["README.md", "DOCUMENTATION.md"];
for (const directory of ["docs", "packages", "examples"]) {
  if (directory === "docs") {
    for (const entry of readdirSync(join(root, directory), { recursive: true })) {
      if (entry.endsWith(".md") && !entry.startsWith(`rfcs${sep}`))
        manuals.push(join(directory, entry));
    }
  } else {
    for (const entry of readdirSync(join(root, directory))) {
      const file = join(directory, entry, "README.md");
      if (existsSync(join(root, file))) manuals.push(file);
    }
  }
}
const destinations = new Map(
  manuals.map((file) => [resolve(root, file), join(target, "manual", file)]),
);
for (const entry of [
  "SKILL.md",
  ...readdirSync(join(skill, "references")).map((file) => join("references", file)),
]) {
  destinations.set(join(skill, entry), join(target, entry));
}
for (const entry of readdirSync(join(skill, "examples"))) {
  destinations.set(join(skill, "examples", entry), join(target, "examples", entry));
}
for (const [source, destination] of destinations) {
  if (!source.endsWith(".md")) continue;
  const content = readFileSync(source, "utf8").replace(
    /(\]\()([^\s)]+)(\))/g,
    (match, open, href, close) => {
      if (/^(?:[a-z]+:|#)/i.test(href)) return match;
      const [path, anchor] = href.split("#");
      const absolute = resolve(dirname(source), path);
      const bundled = destinations.get(absolute);
      const link = bundled
        ? relative(dirname(destination), bundled).split(sep).join("/")
        : `https://github.com/inaiat/resultar/blob/main/${relative(root, absolute).split(sep).join("/")}`;
      if (!bundled && !existsSync(absolute))
        throw new Error(`Broken documentation link: ${source}: ${href}`);
      return `${open}${link}${anchor ? `#${anchor}` : ""}${close}`;
    },
  );
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}
const versions = {};
for (const directory of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const metadata = JSON.parse(
    readFileSync(join(root, "packages", directory.name, "package.json"), "utf8"),
  );
  versions[metadata.name] = metadata.version;
}
writeFileSync(join(target, "versions.json"), JSON.stringify(versions, null, 2) + "\n");
writeFileSync(
  join(core, "dist/llms.txt"),
  `# Resultar ${versions.resultar}

Documentation bundled with this package version. Installed declarations remain authoritative.

- [Agent guide](agent/SKILL.md)
- [API semantics](agent/references/api.md)
- [Anti-patterns and resultar-check rules](agent/references/anti-patterns.md)
- [Production workflow patterns](agent/references/patterns.md)
- [Services, DI, HTTP adapters, and outbound request client](agent/references/services.md)
- [Boundary integrations (HTTP, DB, queues, callbacks)](agent/references/integrations.md)
- [Code review and pre-commit checklist](agent/references/review-checklist.md)
- [Complete human guide](agent/manual/DOCUMENTATION.md)
- [Public API inventory](agent/manual/docs/api-inventory.md)
- [Executable recipes](agent/manual/docs/recipes.md)
- [Compiled core example](agent/examples/workflow.mjs)
- [Companion versions used to write this guide](agent/versions.json)

Read companion packages' installed READMEs when their versions differ from versions.json.
`,
);
const require = createRequire(join(core, "package.json"));
const compiler = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
execFileSync(
  process.execPath,
  [
    compiler,
    "--ignoreConfig",
    "--strict",
    "--skipLibCheck",
    "--target",
    "ESNext",
    "--module",
    "NodeNext",
    "--types",
    "node",
    ...readdirSync(join(target, "examples"))
      .filter((file) => file.endsWith(".mts"))
      .map((file) => join(target, "examples", file)),
  ],
  { cwd: core, stdio: "inherit" },
);
console.log(`Bundled Resultar ${versions.resultar} agent guide and compiled example.`);

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

// Declaration-only chunks have no matching .js file. Deno's local package resolver
// needs their real extension; TypeScript also accepts these declaration imports.
const directory = new URL("../dist/", import.meta.url);
const declarations = readdirSync(directory).filter((name) => name.endsWith(".d.ts"));
for (const name of declarations) {
  const file = new URL(name, directory);
  let code = readFileSync(file, "utf8");
  for (const dependency of declarations) {
    const specifier = `./${dependency.slice(0, -5)}.js`;
    code = code.replaceAll(JSON.stringify(specifier), JSON.stringify(`./${dependency}`));
  }
  writeFileSync(file, code);
}

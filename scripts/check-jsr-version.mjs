import { appendFile, readFile } from "node:fs/promises";

const [jsrJsonPath] = process.argv.slice(2);

if (!jsrJsonPath) {
  throw new Error("Usage: node scripts/check-jsr-version.mjs <path-to-jsr.json>");
}

const jsrJson = JSON.parse(await readFile(jsrJsonPath, "utf8"));
const { name, version } = jsrJson;

if (typeof name !== "string" || typeof version !== "string") {
  throw new Error(`${jsrJsonPath} must contain string name and version fields`);
}

const response = await fetch(`https://jsr.io/${name}/meta.json`);

let published = false;
if (response.status !== 404) {
  if (!response.ok) {
    throw new Error(`Could not fetch JSR metadata for ${name}: HTTP ${response.status}`);
  }

  const metadata = await response.json();
  published = Object.hasOwn(metadata.versions ?? {}, version);
}

console.log(`${name}@${version} is ${published ? "already published" : "not published"} on JSR`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `published=${published}\n`);
}

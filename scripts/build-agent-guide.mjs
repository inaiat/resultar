import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const core = join(root, 'packages/resultar');
const target = join(core, 'dist/agent');
const skill = join(root, 'skills/resultar');
mkdirSync(target, { recursive: true });
for (const name of ['SKILL.md', 'references', 'agents', 'examples']) {
  cpSync(join(skill, name), join(target, name), { recursive: true });
}
const versions = {};
for (const directory of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const metadata = JSON.parse(readFileSync(join(root, 'packages', directory.name, 'package.json'), 'utf8'));
  versions[metadata.name] = metadata.version;
}
writeFileSync(join(target, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
writeFileSync(join(core, 'dist/llms.txt'), `# Resultar ${versions.resultar}

Documentation bundled with this package version. Installed declarations remain authoritative.

- [Agent guide](agent/SKILL.md)
- [API semantics](agent/references/api.md)
- [Services and HTTP scopes](agent/references/services.md)
- [Compiled core example](agent/examples/workflow.mjs)
- [Companion versions used to write this guide](agent/versions.json)

Read companion packages' installed READMEs when their versions differ from versions.json.
`);
const require = createRequire(join(core, 'package.json'));
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
execFileSync(process.execPath, [compiler, '--ignoreConfig', '--strict', '--skipLibCheck',
  '--target', 'ESNext', '--module', 'NodeNext', join(target, 'examples/workflow.mts')],
  { cwd: core, stdio: 'inherit' });
console.log(`Bundled Resultar ${versions.resultar} agent guide and compiled example.`);

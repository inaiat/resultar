import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cases } from '../skills/resultar/evals/cases.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  reference: { type: 'boolean' }, 'self-test': { type: 'boolean' },
  adapter: { type: 'string' }, 'candidate-dir': { type: 'string' },
  guidance: { type: 'string', default: 'with-skill' },
  attempts: { type: 'string', default: '3' }, output: { type: 'string' },
} });
const modes = [values.reference, values['self-test'], values.adapter, values['candidate-dir']].filter(Boolean);
assert.equal(modes.length, 1, 'Choose --reference, --self-test, --adapter script.mjs, or --candidate-dir directory.');
assert.ok(['with-skill', 'without-skill'].includes(values.guidance), 'Invalid --guidance.');
const maxAttempts = Number(values.attempts);
assert.ok(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 10, '--attempts must be 1–10.');
const require = createRequire(join(root, 'packages/resultar/package.json'));
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const checker = join(root, 'packages/check/dist/cli.js');
const catalog = JSON.parse(readFileSync(join(root, 'skills/resultar/evals/evals.json'), 'utf8'));
const guideRoot = join(root, 'packages/resultar/dist/agent');
const versions = JSON.parse(readFileSync(join(guideRoot, 'versions.json'), 'utf8'));
const guidance = values.guidance === 'with-skill'
  ? ['SKILL.md', 'references/api.md', 'references/services.md'].map(file => ({ file, content: readFileSync(join(guideRoot, file), 'utf8') }))
  : [];
const output = resolve(values.output ?? join(tmpdir(), `resultar-evals-${Date.now()}.json`));
const results = [];

function run(args, cwd, timeout = 60000, input) {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, input,
    env: { ...process.env, RESULTAR_EVAL_CHECKER: checker },
  });
  return { status: result.status, stdout: result.stdout ?? '', feedback: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').slice(-16000) };
}

function prepare(test) {
  const directory = mkdtempSync(join(tmpdir(), `resultar-eval-${test.id}-`));
  const dependencies = {
    resultar: 'packages/resultar', 'resultar-request': 'packages/request',
    'resultar-request-typebox': 'packages/request-typebox', 'resultar-request-zod': 'packages/request-zod',
    zod: 'packages/request-zod/node_modules/zod', typebox: 'packages/request-typebox/node_modules/typebox',
    '@types/node': 'packages/resultar/node_modules/@types/node',
  };
  for (const [name, target] of Object.entries(dependencies)) {
    const link = join(directory, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, target), link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(join(directory, 'contract.mts'), test.support ?? 'export {}');
  const config = { compilerOptions: {
    strict: true, skipLibCheck: true, target: 'ESNext', module: 'NodeNext', types: ['node'],
    plugins: [{ name: 'resultar-check', noDiscard: 'error', noUnknownResultError: 'error', failOn: 'warning' }],
  }, include: ['*.mts'], exclude: ['configured'] };
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(join(directory, 'tsconfig.check.json'), JSON.stringify({ ...config, include: ['solution.mts'] }));
  return directory;
}

function grade(test, directory, code) {
  writeFileSync(join(directory, 'solution.mts'), code);
  // Graders are written only after generation; adapters receive the public contract, not answers.
  writeFileSync(join(directory, 'types.mts'), `type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
${test.types}`);
  writeFileSync(join(directory, 'checks.mts'), `import assert from 'node:assert/strict';
import * as solution from './solution.mjs';
${test.checks}`);
  for (const [stage, args, timeout] of [
    ['types', [compiler, '--project', 'tsconfig.json'], 60000],
    ['checker', [checker, '--project', 'tsconfig.check.json', '--json'], 60000],
    ['runtime', [join(directory, 'checks.mjs')], 10000],
  ]) {
    const result = run(args, directory, timeout);
    if (result.status !== 0) return { passed: false, stage, status: result.status, feedback: result.feedback };
  }
  return { passed: true, stage: 'complete', status: 0, feedback: '' };
}

async function evaluate(test, mode) {
  const started = Date.now();
  const attempts = [];
  let feedback = '';
  const limit = values.adapter ? maxAttempts : 1;
  for (let attempt = 1; attempt <= limit; attempt++) {
    const directory = prepare(test);
    let usage;
    let model;
    let code;
    try {
      if (values.adapter) {
        const request = {
          id: test.id, attempt, scenario: catalog.evals.find(item => item.id === test.id).prompt,
          contract: test.contract, support: test.support ?? '', versions, guidance, feedback,
          previousCode: attempts.at(-1)?.code ?? '',
          instruction: 'Return one JSON object with code for solution.mts, optional model and usage. Implement only the executable contract; narrative criteria are assessed separately. Use only the installed dependencies; do not modify configuration, graders or dependencies.',
        };
        const response = run([resolve(values.adapter)], directory, 60000, JSON.stringify(request));
        assert.equal(response.status, 0, response.feedback);
        const parsed = JSON.parse(response.stdout);
        assert.equal(typeof parsed.code, 'string', 'Adapter response must include code.');
        code = parsed.code; usage = parsed.usage; model = parsed.model;
      } else if (values['candidate-dir']) {
        code = readFileSync(resolve(values['candidate-dir'], String(test.id), 'solution.mts'), 'utf8');
      } else {
        code = mode === 'mutation' ? test.mutate(test.reference) : test.reference;
        if (mode === 'mutation') assert.notEqual(code, test.reference, 'Mutation must change the candidate.');
      }
      const result = grade(test, directory, code);
      attempts.push({ attempt, code, ...result, usage, model });
      feedback = result.feedback;
      if (result.passed) break;
    } catch (error) {
      feedback = String(error);
      attempts.push({ attempt, code, passed: false, stage: 'adapter-or-input', feedback });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const passed = attempts.at(-1)?.passed === true;
  const result = { id: test.id, mode, passed, firstAttemptPassed: attempts[0]?.passed === true, attempts, milliseconds: Date.now() - started };
  results.push(result);
  console.log(`case ${test.id} (${mode}): ${passed ? 'PASS' : 'FAIL'} at ${attempts.at(-1)?.stage}, ${attempts.length} attempt(s)`);
}

for (const test of cases) {
  await evaluate(test, values.adapter ? 'agent' : values['candidate-dir'] ? 'candidate' : 'reference');
  if (values['self-test']) await evaluate(test, 'mutation');
}
const graderValidation = Boolean(values.reference || values['self-test']);
const success = results.every(result => result.mode === 'mutation'
  ? !result.passed && result.attempts.at(-1)?.stage !== 'adapter-or-input'
  : result.passed);
const measured = results.filter(result => result.mode !== 'mutation');
const report = {
  schemaVersion: 1, kind: graderValidation ? 'grader-validation' : 'agent-evaluation',
  guidance: values.guidance, versions, success, results,
  metrics: graderValidation ? null : {
    firstAttemptPassRate: measured.filter(result => result.firstAttemptPassed).length / measured.length,
    finalPassRate: measured.filter(result => result.passed).length / measured.length,
    totalAttempts: measured.reduce((sum, result) => sum + result.attempts.length, 0),
    totalMilliseconds: measured.reduce((sum, result) => sum + result.milliseconds, 0),
  },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Report: ${output}`);
process.exitCode = success ? 0 : 1;

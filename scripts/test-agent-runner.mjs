import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { cases } from '../skills/resultar/evals/cases.mjs';

const runner = fileURLToPath(new URL('./eval-agents.mjs', import.meta.url));
const fixtures = fileURLToPath(new URL('../skills/resultar/evals/cases.mjs', import.meta.url));

function withDirectory(body) {
  const directory = mkdtempSync(join(tmpdir(), 'resultar-runner-test-'));
  try { body(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function invoke(directory, args, expectedStatus = 0) {
  const output = join(directory, 'report.json');
  const result = spawnSync(process.execPath, [runner, ...args, '--output', output], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
  return JSON.parse(readFileSync(output, 'utf8'));
}

test('grades submitted code using public types and behavior', () => withDirectory(directory => {
  for (const fixture of cases) {
    const target = join(directory, String(fixture.id)); mkdirSync(target);
    writeFileSync(join(target, 'solution.mts'), fixture.reference);
  }
  const report = invoke(directory, ['--candidate-dir', directory]);
  assert.equal(report.success, true);
  assert.equal(report.metrics.firstAttemptPassRate, 1);
  assert.equal(report.results.length, 7);
}));

test('adapter receives bounded feedback, optional guidance and no grading answers', () => withDirectory(directory => {
  const adapter = join(directory, 'adapter.mjs');
  writeFileSync(adapter, `import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {cases} from ${JSON.stringify(pathToFileURL(fixtures).href)};
const request = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(request.guidance.length, 0);
assert.equal('reference' in request, false);
assert.equal(existsSync('checks.mts'), false);
if(request.attempt > 1) { assert.ok(request.feedback); assert.ok(request.previousCode); }
const fixture = cases.find(item => item.id === request.id);
const source = request.attempt === 1 ? fixture.mutate(fixture.reference) : fixture.reference;
// A long valid JSON response verifies that diagnostic truncation never truncates adapter output.
console.error('adapter log belongs on stderr');
console.log(JSON.stringify({code: source + ' '.repeat(20000), model: 'fixture', usage: {totalTokens: 1}}));
`);
  const report = invoke(directory, ['--adapter', adapter, '--guidance', 'without-skill', '--attempts', '2']);
  assert.equal(report.success, true);
  assert.equal(report.metrics.firstAttemptPassRate, 0);
  assert.equal(report.metrics.finalPassRate, 1);
  assert.equal(report.metrics.totalAttempts, 14);
  for (const result of report.results) assert.equal(result.attempts[1].usage.totalTokens, 1);
}));

test('invalid adapter output fails with a report after the configured attempt limit', () => withDirectory(directory => {
  const adapter = join(directory, 'invalid.mjs');
  writeFileSync(adapter, "console.log('not JSON')");
  const report = invoke(directory, ['--adapter', adapter, '--attempts', '1'], 1);
  assert.equal(report.success, false);
  assert.equal(report.metrics.totalAttempts, 7);
  assert.ok(report.results.every(result => result.attempts[0].stage === 'adapter-or-input'));
}));

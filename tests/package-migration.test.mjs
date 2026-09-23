import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { assertPublishContext, packageName, shouldPublish } from '../scripts/check-publish.mjs';

const manifest = JSON.parse(readFileSync(new URL('../cli/package.json', import.meta.url)));
const candidate = { name: packageName, version: '0.1.3' };
const registry = (status, body) => async (url, options) => {
  assert.equal(url, 'https://registry.npmjs.org/%40companion-ai%2Falpha-hub');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  return { status, json: async () => body };
};
const published = (version) => ({
  name: packageName,
  'dist-tags': { latest: version },
  versions: { [version]: { name: packageName, version } },
});

test('manifest and lock agree on Companion identity without changing public interfaces', () => {
  const lock = JSON.parse(readFileSync(new URL('../cli/package-lock.json', import.meta.url)));
  assert.equal(manifest.name, packageName);
  for (const root of [lock, lock.packages['']]) {
    assert.equal(root.name, manifest.name);
    assert.equal(root.version, manifest.version);
  }
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.deepEqual(manifest.bin, { alpha: './bin/alpha', 'alpha-mcp': './bin/alpha-mcp' });
  assert.deepEqual(lock.packages[''].bin, { alpha: 'bin/alpha', 'alpha-mcp': 'bin/alpha-mcp' });
  assert.deepEqual(manifest.exports, {
    '.': './src/index.js',
    './lib': { types: './src/lib/index.d.ts', default: './src/lib/index.js' },
    './lib/auth': { types: './src/lib/auth.d.ts', default: './src/lib/auth.js' },
    './lib/alphaxiv': './src/lib/alphaxiv.js',
    './lib/annotations': './src/lib/annotations.js',
    './lib/papers': './src/lib/papers.js',
  });
  for (const target of [...Object.values(manifest.bin), ...Object.values(manifest.exports).flatMap(
    (value) => typeof value === 'string' ? [value] : Object.values(value),
  )]) assert.ok(existsSync(new URL(`../cli/${target}`, import.meta.url)), target);
  assert.deepEqual(manifest.repository, {
    type: 'git', url: 'git+https://github.com/Companion-Inc/alpha-hub.git', directory: 'cli',
  });
  assert.equal(manifest.homepage, 'https://github.com/Companion-Inc/alpha-hub#readme');
  assert.equal(manifest.bugs.url, 'https://github.com/Companion-Inc/alpha-hub/issues');
});

test('only an explicit npm package 404 permits first publication', async () => {
  assert.equal(await shouldPublish(candidate, registry(404, { error: 'Not found' })), true);
});

test('already published exact versions are skipped, not republished', async () => {
  assert.equal(await shouldPublish(candidate, registry(200, published('0.1.3'))), false);
});

test('newer stable versions may publish but latest cannot move backwards', async () => {
  assert.equal(await shouldPublish(candidate, registry(200, published('0.1.2'))), true);
  await assert.rejects(shouldPublish(candidate, registry(200, published('0.1.4'))), /older/);
});

for (const status of [301, 401, 403, 429, 500, 502, 503]) {
  test(`HTTP ${status} fails closed even with a not-found body`, async () => {
    await assert.rejects(shouldPublish(candidate, registry(status, { error: 'Not found' })));
  });
}

for (const [label, status, body] of [
  ['ambiguous 404', 404, {}],
  ['authorization 404', 404, { error: 'Unauthorized' }],
  ['empty 200', 200, {}],
  ['missing versions', 200, { name: packageName }],
  ['invalid versions', 200, { name: packageName, versions: [] }],
  ['missing latest', 200, { name: packageName, versions: {} }],
  ['wrong package', 200, { ...published('0.1.3'), name: '@Companion-Inc/alpha-hub' }],
  ['wrong version identity', 200, { ...published('0.1.3'), versions: { '0.1.3': { name: packageName, version: '0.1.0' } } }],
]) {
  test(`${label} fails closed`, async () => {
    await assert.rejects(shouldPublish(candidate, registry(status, body)));
  });
}

test('network, timeout and malformed JSON errors fail closed', async () => {
  for (const message of ['network failure', 'timeout']) {
    await assert.rejects(shouldPublish(candidate, async () => { throw new Error(message); }));
  }
  await assert.rejects(shouldPublish(candidate, async () => ({
    status: 404, json: async () => { throw new SyntaxError('bad JSON'); },
  })));
});

test('main-only context and scope guard reject branches, tags and forks', async () => {
  const env = { GITHUB_REPOSITORY: 'Companion-Inc/alpha-hub', GITHUB_REF: 'refs/heads/main' };
  assert.doesNotThrow(() => assertPublishContext(env, candidate));
  for (const ref of ['refs/heads/feature', 'refs/tags/v0.1.3', undefined]) {
    assert.throws(() => assertPublishContext({ ...env, GITHUB_REF: ref }, candidate));
  }
  assert.throws(() => assertPublishContext({ ...env, GITHUB_REPOSITORY: 'other/alpha-hub' }, candidate));
  assert.throws(() => assertPublishContext(env, { ...candidate, name: '@Companion-Inc/alpha-hub' }));
  await assert.rejects(shouldPublish({ ...candidate, name: '@Companion-Inc/alpha-hub' }));
  assert.throws(() => assertPublishContext(env, { ...candidate, version: '0.1.3-beta.1' }));
});

test('workflow retains existing token, main guard and provenance permission', () => {
  const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /if: github\.repository == 'Companion-Inc\/alpha-hub' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=low/);
  assert.ok(workflow.indexOf('npm audit --omit=dev') < workflow.indexOf('npm publish'));
  assert.match(workflow, /run: node scripts\/check-publish\.mjs/);
  assert.match(workflow, /if: steps\.check\.outputs\.publish == 'true'/);
  assert.doesNotMatch(workflow, /npm view|advaitpaliwal/);
});

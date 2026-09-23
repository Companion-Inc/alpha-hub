// Run from cli/ or a clean consumer containing the installed tarball.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const home = mkdtempSync(resolve(tmpdir(), 'alpha-hub-smoke-home-'));
const originalHome = process.env.HOME;
process.env.HOME = home;
globalThis.fetch = () => { throw new Error('Network forbidden in consumer smoke'); };
const require = createRequire(resolve('package.json'));
const packageName = '@companion-ai/alpha-hub';
const entry = require.resolve(packageName);
const root = resolve(dirname(entry), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json')));
const load = (specifier) => import(pathToFileURL(require.resolve(specifier)));

try {
  assert.equal(manifest.name, packageName);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  for (const subpath of Object.keys(manifest.exports)) {
    const specifier = subpath === '.' ? packageName : packageName + subpath.slice(1);
    assert.ok(require.resolve(specifier));
    if (subpath !== '.') await load(specifier);
  }
  const help = execFileSync(process.execPath, [resolve(root, 'bin/alpha'), '--help'], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.match(help, /search/);
  const version = execFileSync(process.execPath, [resolve(root, 'bin/alpha'), '--cli-version'], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(version.trim(), manifest.version);
  const runCli = (...args) => execFileSync(process.execPath, [resolve(root, 'bin/alpha'), ...args], {
    encoding: 'utf8', timeout: 10_000,
  });
  for (const command of ['search', 'get', 'ask', 'code', 'annotate', 'login', 'status']) {
    assert.match(runCli(command, '--help'), /Usage:/);
  }
  const savedCli = JSON.parse(runCli('--json', 'annotate', '2401.00001', 'Commander compatibility smoke'));
  assert.equal(savedCli.note, 'Commander compatibility smoke');
  assert.equal(JSON.parse(runCli('annotate', '--list', '--json')).length, 1);
  assert.match(runCli('annotate', '2401.00001', '--clear'), /Cleared annotation/);

  const lib = await load(`${packageName}/lib`);
  const auth = await load(`${packageName}/lib/auth`);
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(lib.normalizePaperId('https://arxiv.org/abs/1706.03762'), '1706.03762');
  const parsed = lib.parsePaperSearchResults(
    '1. **Attention Is All You Need** (42 Visits, 7 Likes, Published on 2017-06-12)\n' +
    '- arXiv Id: 1706.03762\n- Authors: Example Author\n- Abstract: Mock paper text.',
  );
  assert.equal(parsed.results[0].arxivId, '1706.03762');
  assert.equal(parsed.results[0].visits, 42);
  await lib.annotatePaper('1706.03762', 'Offline migration smoke');
  assert.equal((await lib.getPaperAnnotation('1706.03762')).annotation.note, 'Offline migration smoke');
  assert.equal((await lib.listPaperAnnotations()).total, 1);
  assert.equal((await lib.clearPaperAnnotation('1706.03762')).status, 'cleared');

  const packageRequire = createRequire(resolve(root, 'package.json'));
  const { Client } = await import(pathToFileURL(packageRequire.resolve('@modelcontextprotocol/sdk/client/index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(packageRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
  const client = new Client({ name: 'migration-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'bin/alpha-mcp')],
    env: { HOME: home, PATH: process.env.PATH },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, manifest.version);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(),
      ['alpha_annotate', 'alpha_ask', 'alpha_code', 'alpha_get', 'alpha_search']);
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
    for (const schema of Object.values(schemas)) assert.equal(schema.type, 'object');
    assert.deepEqual(schemas.alpha_search.required, ['query']);
    assert.equal(schemas.alpha_search.properties.query.type, 'string');
    assert.deepEqual(schemas.alpha_search.properties.mode.enum, ['semantic', 'keyword', 'agentic']);
    assert.deepEqual(schemas.alpha_get.required, ['url']);
    assert.equal(schemas.alpha_get.properties.full_text.type, 'boolean');
    assert.deepEqual(schemas.alpha_ask.required, ['url', 'question']);
    assert.deepEqual(schemas.alpha_code.required, ['github_url']);
    assert.equal(schemas.alpha_annotate.properties.list.type, 'boolean');
    assert.equal(schemas.alpha_annotate.required?.length || 0, 0);
    const result = await client.callTool({ name: 'alpha_annotate', arguments: { list: true } });
    assert.equal(JSON.parse(result.content[0].text).total, 0);
    const savedMcp = await client.callTool({
      name: 'alpha_annotate', arguments: { id: '2401.00002', note: 'Zod 4 compatibility smoke' },
    });
    assert.equal(JSON.parse(savedMcp.content[0].text).annotation.note, 'Zod 4 compatibility smoke');
    const clearedMcp = await client.callTool({ name: 'alpha_annotate', arguments: { id: '2401.00002', clear: true } });
    assert.equal(JSON.parse(clearedMcp.content[0].text).status, 'cleared');
    const invalidMcp = await client.callTool({ name: 'alpha_annotate', arguments: { list: 'not-a-boolean' } });
    assert.equal(invalidMcp.isError, true);
    assert.match(invalidMcp.content[0].text, /validation|Invalid|boolean/i);
  } finally {
    await client.close();
  }
  console.log('PASS: package exports, Commander CLI/help/JSON flags, mock paper parsing, isolated annotations, MCP handshake/Zod schemas/valid and invalid calls');
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
}

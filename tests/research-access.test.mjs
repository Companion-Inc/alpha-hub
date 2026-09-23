import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadSource } from './helpers/load-source.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
const modern = '1. [ID=1706.03762] **Attention Is All You Need**. Published 2017-06-12 by Example Lab: Transformer abstract.';

function mockAuth({ state = 'valid', callback = true, platform = 'darwin', env = {}, tty = false, failCommands = [] } = {}) {
  const files = new Map();
  const modes = new Map();
  const calls = [];
  const commands = [];
  const stderr = [];
  let opened;
  const statuses = [];
  let rl;
  let serverClosed = false;
  const server = new EventEmitter();
  server.listen = (_port, _host, done) => done();
  server.close = () => { serverClosed = true; };
  const stubs = {
    'node:fs': {
      existsSync: (file) => files.has(file),
      mkdirSync() {},
      readFileSync: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
      writeFileSync: (file, content, options) => {
        if (options?.flag === 'wx' && files.has(file)) throw new Error('EEXIST');
        files.set(file, content);
        modes.set(file, options?.mode);
      },
      renameSync: (from, to) => {
        files.set(to, files.get(from));
        modes.set(to, modes.get(from));
        files.delete(from);
        modes.delete(from);
      },
      unlinkSync: (file) => files.delete(file),
    },
    'node:os': { homedir: () => '/mock-home', platform: () => platform },
    'node:http': { createServer: () => server },
    'node:readline': {
      createInterface: () => {
        rl = new EventEmitter();
        rl.closed = false;
        rl.close = () => { rl.closed = true; };
        return rl;
      },
    },
    'node:child_process': {
      execSync: (command) => {
        commands.push(command);
        if (failCommands.some((prefix) => command.startsWith(prefix))) throw new Error('not installed');
        opened = new URL(command.match(/"(https:[^"]+)"$/)[1]);
        if (!callback) return;
        const valid = `/callback?code=mock-code&state=${opened.searchParams.get('state')}`;
        // A foreign or stateless callback is answered and ignored; the real one follows.
        const requests = {
          valid: [valid],
          wrong: ['/callback?code=stolen&state=wrong', valid],
          missing: ['/callback?code=stolen', valid],
          error: [`/callback?error=access_denied&state=${opened.searchParams.get('state')}`],
        }[state];
        queueMicrotask(() => {
          for (const url of requests) {
            server.emit('request', { url }, { writeHead: (status) => { statuses.push(status); }, end() {} });
          }
        });
      },
    },
  };
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    if (url === 'https://api.alphaxiv.org/auth/oauth2/register') {
      return { ok: true, json: async () => ({ client_id: 'mock-client' }) };
    }
    if (url === 'https://api.alphaxiv.org/auth/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 3600 }) };
    }
    if (url === 'https://api.alphaxiv.org/auth/oauth2/userinfo') {
      return { ok: true, json: async () => ({ sub: 'mock-user', name: 'Mock User' }) };
    }
    throw new Error(`Unexpected endpoint: ${url}`);
  };
  const process = {
    env,
    stderr: { write: (text) => { stderr.push(text); } },
    ...(tty ? { stdin: { isTTY: true } } : {}),
  };
  return {
    stubs, globals: { fetch, process }, files, modes, calls, commands,
    opened: () => opened, callbackStatus: () => statuses.at(-1), statuses: () => statuses,
    readline: () => rl, serverClosed: () => serverClosed, stderr: () => stderr.join(''),
  };
}

// The authorize URL printed to stderr, as a user would copy it.
function printedAuthUrl(mock) {
  return new URL(mock.stderr().match(/https:\/\/api\.alphaxiv\.org\/auth\/oauth2\/authorize\S+/)[0]);
}

test('OAuth login executes current registration, authorize, token and userinfo flow with PKCE/state', async () => {
  const mock = mockAuth();
  const auth = await loadSource('../../cli/src/lib/auth.js', mock);
  const result = await auth.login();
  assert.equal(result.userInfo.name, 'Mock User');
  const opened = mock.opened();
  assert.equal(opened.origin + opened.pathname, 'https://api.alphaxiv.org/auth/oauth2/authorize');
  assert.equal(opened.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(opened.searchParams.get('code_challenge'));
  assert.ok(opened.searchParams.get('state'));
  assert.equal(opened.searchParams.get('redirect_uri'), 'http://127.0.0.1:9876/callback');
  assert.equal(mock.callbackStatus(), 200);
  assert.deepEqual(mock.calls.map((call) => call.url), [
    'https://api.alphaxiv.org/auth/oauth2/register',
    'https://api.alphaxiv.org/auth/oauth2/token',
    'https://api.alphaxiv.org/auth/oauth2/userinfo',
  ]);
  const registration = JSON.parse(mock.calls[0].body);
  assert.equal(registration.token_endpoint_auth_method, 'none');
  const tokenBody = new URLSearchParams(mock.calls[1].body);
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.equal(tokenBody.get('code'), 'mock-code');
  assert.ok(tokenBody.get('code_verifier'));
  assert.equal(await auth.refreshAccessToken(), 'mock-access');
  assert.equal(mock.calls.at(-1).url, 'https://api.alphaxiv.org/auth/oauth2/token');
  assert.equal(new URLSearchParams(mock.calls.at(-1).body).get('grant_type'), 'refresh_token');
  assert.ok(mock.files.has('/mock-home/.ahub/auth.json'));
  assert.equal(mock.modes.get('/mock-home/.ahub/auth.json'), 0o600);
  assert.equal(mock.readline(), undefined, 'no paste prompt without a terminal');
  assert.equal(printedAuthUrl(mock).href, opened.href);
});

for (const state of ['wrong', 'missing']) {
  test(`OAuth ${state}-state callback is rejected without ending the login`, async () => {
    const mock = mockAuth({ state });
    const auth = await loadSource('../../cli/src/lib/auth.js', mock);
    await auth.login();
    assert.deepEqual(mock.statuses(), [400, 200]);
    assert.equal(new URLSearchParams(mock.calls[1].body).get('code'), 'mock-code', 'the foreign code is never exchanged');
  });
}

test('an OAuth error with this attempt\'s state ends the login before any token exchange', async () => {
  const mock = mockAuth({ state: 'error' });
  const auth = await loadSource('../../cli/src/lib/auth.js', mock);
  await assert.rejects(auth.login(), /OAuth error: access_denied/);
  assert.deepEqual(mock.statuses(), [400]);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.files.size, 0);
  assert.equal(mock.serverClosed(), true);
});

test('headless login completes from a pasted redirect URL and still checks state', async () => {
  const mock = mockAuth({ platform: 'linux', tty: true });
  const auth = await loadSource('../../cli/src/lib/auth.js', mock);
  const pending = auth.login();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(mock.commands, [], 'no browser is launched without a display');
  const authUrl = printedAuthUrl(mock);
  const state = authUrl.searchParams.get('state');
  assert.match(mock.stderr(), /paste the\s+full URL/);
  const rl = mock.readline();
  for (const line of [
    'not a url at all',
    'https://www.alphaxiv.org/',
    `http://127.0.0.1:9876/callback?code=stolen&state=wrong`,
    `http://127.0.0.1:9876/callback?state=${state}`,
  ]) rl.emit('line', line);
  assert.equal(mock.calls.length, 1, 'bad pastes never reach the token endpoint');
  assert.equal((mock.stderr().match(/Could not use that URL/g) || []).length, 4);
  assert.match(mock.stderr(), /OAuth state mismatch/);
  rl.emit('line', `  127.0.0.1:9876/callback?code=pasted-code&state=${state}  `);
  const result = await pending;
  assert.equal(result.userInfo.name, 'Mock User');
  assert.equal(new URLSearchParams(mock.calls[1].body).get('code'), 'pasted-code');
  assert.equal(rl.closed, true);
  assert.equal(mock.serverClosed(), true);
  assert.ok(mock.files.has('/mock-home/.ahub/auth.json'));
});

test('browser callback still wins in a terminal and closes the paste prompt', async () => {
  const mock = mockAuth({ tty: true });
  const auth = await loadSource('../../cli/src/lib/auth.js', mock);
  await auth.login();
  assert.equal(mock.readline().closed, true);
  assert.equal(mock.serverClosed(), true);
  assert.equal(new URLSearchParams(mock.calls[1].body).get('code'), 'mock-code');
});

test('a pasted OAuth error with this attempt\'s state ends the login', async () => {
  const mock = mockAuth({ platform: 'linux', tty: true });
  const auth = await loadSource('../../cli/src/lib/auth.js', mock);
  const pending = auth.login();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const state = printedAuthUrl(mock).searchParams.get('state');
  mock.readline().emit('line', 'http://127.0.0.1:9876/callback?error=access_denied&state=wrong');
  mock.readline().emit('line', `http://127.0.0.1:9876/callback?error=access_denied&state=${state}`);
  await assert.rejects(pending, /OAuth error: access_denied/);
  assert.match(mock.stderr(), /Could not use that URL: OAuth state mismatch/);
  assert.equal(mock.calls.length, 1);
});

const AUTH_PATH = '/mock-home/.ahub/auth.json';

// Stored credentials plus a token endpoint whose refresh responses the test releases.
async function mockRefresh({ expired = true, ok = true } = {}) {
  const mock = mockAuth();
  mock.files.set(AUTH_PATH, JSON.stringify({
    client_id: 'mock-client', access_token: 'old-access', refresh_token: 'old-refresh',
    expires_at: expired ? Date.now() - 1000 : Date.now() + 3_600_000, user_name: 'Mock User',
  }));
  const refreshes = [];
  const pending = [];
  mock.globals.fetch = async (url, options) => {
    assert.equal(url, 'https://api.alphaxiv.org/auth/oauth2/token');
    refreshes.push(new URLSearchParams(options.body).get('refresh_token'));
    await new Promise((resolve) => pending.push(resolve));
    return {
      ok, status: ok ? 200 : 400,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    };
  };
  const auth = await loadSource('../../cli/src/lib/auth.js', mock);
  const release = async () => {
    while (!pending.length) await new Promise((resolve) => setTimeout(resolve, 0));
    pending.shift()();
  };
  const stored = () => JSON.parse(mock.files.get(AUTH_PATH));
  return { mock, auth, refreshes, release, stored };
}

test('parallel token refreshes share one request so rotation cannot race', async () => {
  const { auth, refreshes, release, stored } = await mockRefresh();
  const results = Promise.all([auth.getValidToken(), auth.getValidToken(), auth.refreshAccessToken()]);
  await release();
  assert.deepEqual(await results, ['new-access', 'new-access', 'new-access']);
  assert.deepEqual(refreshes, ['old-refresh']);
  assert.equal(stored().refresh_token, 'new-refresh');
  assert.equal(stored().user_name, 'Mock User');
  // The next refresh uses the rotated token.
  const next = auth.refreshAccessToken();
  await release();
  await next;
  assert.deepEqual(refreshes, ['old-refresh', 'new-refresh']);
});

// The error alphaXiv's MCP endpoint returns for an expired or revoked access token.
const INVALID_AUTHORIZATION = 'Streamable HTTP error: Error POSTing to endpoint: {"error":{"message":"Invalid Authorization"}}';
function invalidAuthorization({ withCode = true } = {}) {
  const err = new Error(INVALID_AUTHORIZATION);
  if (withCode) err.code = 401;
  return err;
}

// Real alphaxiv.js + real auth.js; the MCP server rejects the listed access tokens.
async function mockAuthedSearch({ rejected = ['old-access'], at = 'call', ok = true, toolError = null } = {}) {
  const { mock, refreshes, release } = await mockRefresh({ expired: false, ok });
  const clients = [];
  const calls = [];
  class Client {
    async connect(transport) {
      this.token = transport.token;
      clients.push(this);
      if (at === 'connect' && rejected.includes(this.token)) throw invalidAuthorization({ withCode: false });
    }
    async close() { this.closed = true; }
    async callTool(request) {
      calls.push({ token: this.token, name: request.name });
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (at === 'call' && rejected.includes(this.token)) throw invalidAuthorization();
      if (toolError) return { isError: true, content: [{ type: 'text', text: toolError }] };
      return { content: [{ type: 'text', text: modern }] };
    }
  }
  class StreamableHTTPClientTransport {
    constructor(_url, options) { this.token = options.requestInit.headers.Authorization.slice('Bearer '.length); }
  }
  const raw = await loadSource('../../cli/src/lib/alphaxiv.js', {
    stubs: {
      ...mock.stubs,
      '@modelcontextprotocol/sdk/client/index.js': { Client },
      '@modelcontextprotocol/sdk/client/streamableHttp.js': { StreamableHTTPClientTransport },
    },
    globals: mock.globals,
  });
  return { raw, refreshes, release, clients, calls };
}

for (const at of ['connect', 'call']) {
  test(`"Invalid Authorization" at ${at} time triggers one shared refresh and one retry`, async () => {
    const { raw, refreshes, release, clients, calls } = await mockAuthedSearch({ at });
    const all = raw.searchAll('graph networks');
    await release();
    assert.deepEqual(Object.keys(await all), ['semantic', 'keyword', 'agentic']);
    assert.deepEqual(refreshes, ['old-refresh'], 'parallel failures share one refresh');
    assert.deepEqual(clients.map((client) => client.token), ['old-access', 'new-access']);
    if (at === 'call') assert.equal(clients[0].closed, true, 'the stale connection is closed');
    assert.deepEqual(calls.filter((call) => call.token === 'new-access').length, 2, 'each call is retried once');
    await raw.disconnect();
  });
}

test('a failed refresh after "Invalid Authorization" asks the user to log in again', async () => {
  const { raw, refreshes, release, calls } = await mockAuthedSearch({ ok: false });
  const result = assert.rejects(raw.getPaperContent('https://arxiv.org/abs/1706.03762'), /Run `alpha login`/);
  await release();
  await result;
  assert.equal(refreshes.length, 1);
  assert.equal(calls.length, 1);
});

test('a token still rejected after refreshing fails after one retry', async () => {
  const { raw, refreshes, release, calls } = await mockAuthedSearch({ rejected: ['old-access', 'new-access'] });
  const result = assert.rejects(raw.getPaperContent('https://arxiv.org/abs/1706.03762'), /Run `alpha login`/);
  await release();
  await result;
  assert.deepEqual(refreshes, ['old-refresh']);
  assert.deepEqual(calls.map((call) => call.token), ['old-access', 'new-access']);
});

test('tool errors mentioning authorization do not trigger a refresh', async () => {
  const { raw, refreshes, calls } = await mockAuthedSearch({ rejected: [], toolError: 'Unauthorized: private paper' });
  await assert.rejects(raw.getPaperContent('https://arxiv.org/abs/1706.03762'), /^Error: Unauthorized: private paper$/);
  assert.equal(refreshes.length, 0);
  assert.equal(calls.length, 1);
});

test('a logout during a token refresh is not undone by the refresh', async () => {
  const { auth, release, stored } = await mockRefresh();
  const token = auth.getValidToken();
  await new Promise((resolve) => setTimeout(resolve, 0));
  auth.logout();
  await release();
  assert.equal(await token, null);
  assert.deepEqual(stored(), {});
  assert.equal(auth.isLoggedIn(), false);
});

for (const ok of [true, false]) {
  test(`a refresh ${ok ? 'success' : 'failure'} defers to tokens another process stored meanwhile`, async () => {
    const { mock, auth, release, stored } = await mockRefresh({ ok });
    const token = auth.refreshAccessToken();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const other = { client_id: 'mock-client', access_token: 'other-access', refresh_token: 'other-refresh', expires_at: Date.now() + 3_600_000 };
    mock.files.set(AUTH_PATH, JSON.stringify(other));
    await release();
    assert.equal(await token, 'other-access');
    assert.deepEqual(stored(), other);
  });
}

test('auth.json is replaced by renaming a new owner-only file, leaving no temp files', async () => {
  const { mock, auth, release } = await mockRefresh();
  mock.modes.set(AUTH_PATH, 0o644);
  const token = auth.refreshAccessToken();
  await release();
  await token;
  assert.equal(mock.modes.get(AUTH_PATH), 0o600);
  assert.deepEqual([...mock.files.keys()], [AUTH_PATH]);
  auth.logout();
  assert.equal(mock.modes.get(AUTH_PATH), 0o600);
  assert.deepEqual([...mock.files.keys()], [AUTH_PATH]);
});

for (const [label, options, expected] of [
  ['macOS', { platform: 'darwin' }, ['open']],
  ['Windows', { platform: 'win32' }, ['start ""']],
  ['Linux desktop', { platform: 'linux', env: { DISPLAY: ':0' } }, ['xdg-open']],
  ['WSL with wslview', { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } }, ['wslview']],
  ['WSL without wslview', { platform: 'linux', env: { WSL_INTEROP: '/run/WSL/1_interop' }, failCommands: ['wslview'] },
    ['wslview', 'rundll32.exe url.dll,FileProtocolHandler']],
]) {
  test(`login opens the browser on ${label}`, async () => {
    const mock = mockAuth(options);
    const auth = await loadSource('../../cli/src/lib/auth.js', mock);
    await auth.login();
    assert.deepEqual(mock.commands.map((command) => command.slice(0, command.indexOf(' "https:'))), expected);
    for (const command of mock.commands) assert.ok(command.endsWith(`"${mock.opened().href}"`), command);
  });
}

async function mockSearch(payload = modern, failure = null, rest = { ok: true }) {
  const calls = [];
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url: new URL(url), headers: options.headers });
    return {
      ok: rest.ok, status: rest.ok ? 200 : 503, statusText: 'Unavailable',
      text: async () => 'Unavailable',
      json: async () => [{ link: '/abs/2401.00001', paperId: '2401.00001', title: 'REST Paper', snippet: 'REST abstract.' }],
    };
  };
  const clients = [];
  class Client {
    constructor() { clients.push(this); }
    async connect() { await new Promise((resolve) => setTimeout(resolve, 1)); }
    async close() { this.closed = true; }
    async callTool(request) {
      calls.push(plain(request));
      if (failure) throw new Error(failure);
      return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
    }
  }
  const stubs = {
    '@modelcontextprotocol/sdk/client/index.js': { Client },
    '@modelcontextprotocol/sdk/client/streamableHttp.js': { StreamableHTTPClientTransport: class {} },
    [new URL('../cli/src/lib/auth.js', import.meta.url).href]: {
      getValidToken: async () => 'mock-access', refreshAccessToken: async () => null,
      getUserName: () => null, isLoggedIn: () => true, login() {}, logout() {},
    },
  };
  const lib = await loadSource('../../cli/src/lib/index.js', { stubs, globals: { fetch } });
  const raw = await loadSource('../../cli/src/lib/alphaxiv.js', { stubs, globals: { fetch } });
  return { lib, raw, calls, requests, stubs, clients };
}

test('search wrappers call discover_papers with array keywords/numeric difficulty, never removed tools', async () => {
  const { raw, calls } = await mockSearch();
  await raw.searchByEmbedding('  graph   networks ');
  await raw.searchByKeyword('graph networks');
  await raw.agenticSearch('graph networks');
  assert.deepEqual(calls.map((call) => call.name), Array(3).fill('discover_papers'));
  assert.deepEqual(calls.map((call) => call.arguments), [1, 1, 3].map((difficulty, index) => ({
    keywords: ['graph', 'networks'], question: index === 0 ? 'graph   networks' : 'graph networks', difficulty,
  })));
  await assert.rejects(raw.searchByEmbedding(' \t '), /must not be empty/);
  assert.equal(calls.length, 3);
});

test('REST search is used only when the MCP server no longer offers discover_papers', async () => {
  const missing = await mockSearch(modern, 'MCP error -32602: Tool discover_papers not found');
  const parsed = await missing.lib.searchPapers(' graph networks ', 'keyword');
  assert.equal(parsed.results[0].arxivId, '2401.00001');
  assert.equal(parsed.results[0].title, 'REST Paper');
  assert.equal(missing.requests.length, 1);
  const { url, headers } = missing.requests[0];
  assert.equal(url.origin + url.pathname, 'https://api.alphaxiv.org/search/v2/paper/fast');
  assert.equal(url.searchParams.get('q'), 'graph networks');
  assert.equal(url.searchParams.get('includePrivate'), 'false');
  assert.equal(headers.Authorization, 'Bearer mock-access');
  const down = await mockSearch(modern, 'Tool discover_papers not found', { ok: false });
  await assert.rejects(down.raw.searchByKeyword('graph'), /REST search failed \(503\)/);
  for (const message of ['MCP error -32602: Invalid arguments', '401 Unauthorized', 'Tool different_tool not found']) {
    const other = await mockSearch(modern, message);
    await assert.rejects(other.raw.searchByKeyword('graph'));
    assert.equal(other.requests.length, 0, message);
  }
});

test('search all and both retain compatibility keys and deduplicate broad requests', async () => {
  const { lib, raw, calls, clients } = await mockSearch();
  assert.deepEqual(Object.keys(await raw.searchAll('graph')), ['semantic', 'keyword', 'agentic']);
  assert.equal(calls.length, 2);
  assert.equal(clients.length, 1, 'parallel searches share one MCP connection');
  await raw.disconnect();
  assert.equal(clients[0].closed, true);
  const both = await lib.searchPapers('graph', 'both');
  assert.deepEqual(Object.keys(both), ['query', 'mode', 'semantic', 'keyword']);
  assert.equal(calls.length, 3);
  const all = await lib.searchPapers('graph', 'all');
  assert.deepEqual(Object.keys(all), ['query', 'mode', 'semantic', 'keyword', 'agentic']);
  assert.equal(calls.length, 5);
  for (const key of ['semantic', 'keyword', 'agentic']) {
    assert.equal(all[key].results[0].arxivId, '1706.03762');
  }
});

test('modern, legacy and structured paper results preserve the library result fields', async () => {
  const { lib } = await mockSearch();
  const legacy = '1. **Legacy Paper** (42 Visits, 7 Likes, Published on 2017-06-12)\n- arXiv Id: 1706.03762\n- Authors: Example Author\n- Abstract: Legacy abstract.';
  const entry = { link: '/abs/1706.03762', title: 'Structured Paper', snippet: 'Structured abstract.' };
  const payloads = [modern, legacy, [entry], { results: [entry] }, { papers: [entry] }, { data: [entry] }];
  for (const payload of payloads) {
    const parsed = lib.parsePaperSearchResults(payload, { includeRaw: true });
    const result = parsed.results[0];
    assert.equal(result.arxivId, '1706.03762');
    assert.equal(result.arxivUrl, 'https://arxiv.org/abs/1706.03762');
    assert.equal(result.alphaXivUrl, 'https://www.alphaxiv.org/overview/1706.03762');
    for (const field of ['rank', 'title', 'visits', 'likes', 'publishedAt', 'organizations', 'authors', 'abstract', 'raw']) {
      assert.ok(Object.hasOwn(result, field), field);
    }
    assert.ok(parsed.raw);
  }
  const multiple = lib.parsePaperSearchResults(modern + '\n2. [ID=2401.00001] **Wrapped\nTitle**. Published 2024-01-01: Second\nabstract.');
  assert.equal(multiple.results.length, 2);
  assert.equal(multiple.results[1].title, 'Wrapped Title');
  assert.equal(multiple.results[1].abstract, 'Second abstract.');
  assert.equal(lib.parsePaperSearchResults(legacy).results[0].visits, 42);
  assert.deepEqual(plain(lib.parsePaperSearchResults(null)), { results: [] });
  const structured = await mockSearch([entry]);
  assert.equal((await structured.lib.searchPapers('graph')).results[0].title, 'Structured Paper');
});

test('discovery source URLs and vote/view metrics preserve normalized paper fields', async () => {
  const fixture = readFileSync(new URL('./fixtures/discover-paper-formats.txt', import.meta.url), 'utf8').trim();
  const { lib } = await mockSearch(fixture);
  const parsed = await lib.searchPapers('synthetic papers', 'semantic', { includeRaw: true });
  assert.equal(parsed.results.length, 4);
  assert.equal(parsed.raw, fixture);
  const expected = [
    ['2401.00001', 'Synthetic Grouped Paper', '2024-01-01', 'Example University, Example Lab', 1118, 181172, 'Synthetic grouped abstract.'],
    ['2606.00002', 'Synthetic Paper: No Groups', '2026-06-01', null, 13, 110, 'Synthetic abstract without organizations.'],
    ['2401.00003', 'Synthetic Prior Format', '2024-01-03', 'Example Lab', null, null, 'Synthetic prior-format abstract.'],
    ['2401.00004', 'Synthetic Wrapped Title', '2024-01-04', 'Example Lab', 0, 1234, 'Synthetic wrapped abstract.'],
  ];
  expected.forEach(([id, title, date, organizations, likes, visits, abstract], index) => {
    const result = parsed.results[index];
    assert.deepEqual(plain(result), {
      rank: index + 1, arxivId: id, title, publishedAt: date, organizations,
      authors: null, likes, visits, abstract,
      arxivUrl: `https://arxiv.org/abs/${id}`, alphaXivUrl: `https://www.alphaxiv.org/overview/${id}`,
      raw: result.raw,
    });
    assert.match(result.raw, /^\d+\. \[ID=/);
    assert.doesNotMatch(result.organizations || '', /votes|views/);
  });
  for (const metadata of ['', ' · 5 votes', ' · 9 views', ' · 5 votes · 9 views']) {
    const result = lib.parsePaperSearchResults(
      `1. [ID=2401.00005] **Synthetic Optional Fields**. Published 2024-01-05${metadata}: Synthetic abstract.`,
    ).results[0];
    assert.equal(result.organizations, null);
    assert.equal(result.likes, metadata.includes('votes') ? 5 : null);
    assert.equal(result.visits, metadata.includes('views') ? 9 : null);
    assert.equal(result.abstract, 'Synthetic abstract.');
  }
});

test('alphaXiv-hosted paper IDs route to alphaXiv, not arXiv', async () => {
  const { lib } = await mockSearch();
  const hosted = '2607.hardware-aware-dynamic-speculative-decoding';
  const result = lib.parsePaperSearchResults(
    `1. [ID=${hosted}] **Synthetic Hosted Paper** (https://www.alphaxiv.org/abs/${hosted}). Published 2026-07-10 · 48 votes · 199 views: Synthetic abstract.`,
  ).results[0];
  assert.equal(result.arxivId, hosted);
  assert.equal(result.arxivUrl, null);
  assert.equal(result.alphaXivUrl, `https://www.alphaxiv.org/overview/${hosted}`);
  assert.equal(lib.parsePaperSearchResults([{ paperId: hosted, title: 'Hosted' }]).results[0].arxivUrl, null);
  const papers = await loadSource('../../cli/src/lib/papers.js');
  for (const [input, id, url] of [
    ['1706.03762', '1706.03762', 'https://arxiv.org/abs/1706.03762'],
    ['1706.03762v5', '1706.03762v5', 'https://arxiv.org/abs/1706.03762v5'],
    ['hep-th/9901001', 'hep-th/9901001', 'https://arxiv.org/abs/hep-th/9901001'],
    ['https://arxiv.org/pdf/1706.03762', '1706.03762', 'https://arxiv.org/abs/1706.03762'],
    ['https://www.alphaxiv.org/abs/1706.03762v2', '1706.03762', 'https://arxiv.org/abs/1706.03762'],
    [hosted, hosted, `https://www.alphaxiv.org/abs/${hosted}`],
    [`https://www.alphaxiv.org/overview/${hosted}`, hosted, `https://www.alphaxiv.org/overview/${hosted}`],
  ]) {
    assert.equal(papers.normalizePaperId(input), id, input);
    assert.equal(papers.toArxivUrl(input), url, input);
  }
});

test('paper Q&A uses paper/queries and preserves returned XML sections, not a generated answer', async () => {
  const xml = '<paper id="1706.03762"><page num="4">Synthetic optimizer evidence.</page></paper>';
  const { raw, lib, calls } = await mockSearch(xml);
  assert.equal(await raw.answerPdfQuery('https://arxiv.org/abs/1706.03762', 'Which optimizer?'), xml);
  assert.deepEqual(calls[0], {
    name: 'answer_pdf_queries',
    arguments: { paper: 'https://arxiv.org/abs/1706.03762', queries: ['Which optimizer?'] },
  });
  assert.equal((await lib.askPaper('1706.03762', 'Which optimizer?')).answer, xml);
  const failing = await mockSearch(modern, 'Permission denied');
  await assert.rejects(failing.raw.searchByKeyword('graph'), /Permission denied/);
  assert.equal(failing.calls.length, 1);
});

test('existing CLI and MCP search entrypoints execute the adapter without changing JSON shapes', async () => {
  const { stubs, calls } = await mockSearch();
  const printed = [];
  const command = await loadSource('../../cli/src/commands/search.js', {
    stubs: { ...stubs, chalk: { default: { dim: (value) => value } } },
    globals: { console: { log: (value) => printed.push(value) } },
  });
  let action;
  const program = {
    command() { return this; }, description() { return this; }, option() { return this; },
    opts: () => ({ json: true }), action(fn) { action = fn; },
  };
  command.registerSearchCommand(program);
  for (const mode of ['semantic', 'keyword', 'agentic', 'both', 'all']) {
    await action('graph networks', { mode });
    const result = JSON.parse(printed.at(-1));
    if (mode === 'both') assert.deepEqual(Object.keys(result), ['semantic', 'keyword']);
    else if (mode === 'all') assert.deepEqual(Object.keys(result), ['semantic', 'keyword', 'agentic']);
    else assert.equal(result, modern);
  }
  const mcp = await loadSource('../../cli/src/mcp/tools.js', { stubs });
  for (const mode of ['semantic', 'keyword', 'agentic']) {
    const result = await mcp.handleSearch({ query: 'graph networks', mode });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, modern);
  }
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.name === 'discover_papers'));
});

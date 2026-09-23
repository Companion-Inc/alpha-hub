import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getValidToken, refreshAccessToken } from './auth.js';

const ALPHAXIV_MCP_URL = 'https://api.alphaxiv.org/mcp/v1';
const ALPHAXIV_REST_SEARCH_URL = 'https://api.alphaxiv.org/search/v2/paper/fast';

let _client = null;
let _connected = false;
let _connecting = null;
let _lastTransportLog = { message: '', time: 0 };

function getErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function isTransientTransportError(err) {
  const message = getErrorMessage(err);
  return (
    message.includes('SSE stream disconnected') ||
    message.includes('Failed to open SSE stream') ||
    message.includes('Failed to reconnect SSE stream') ||
    message.includes('Maximum reconnection attempts') ||
    message.includes('Bad Gateway') ||
    message.includes('terminated')
  );
}

function logTransportError(err) {
  const message = getErrorMessage(err);

  if (isTransientTransportError(message)) {
    const now = Date.now();
    if (_lastTransportLog.message === message && now - _lastTransportLog.time < 10000) {
      return;
    }
    _lastTransportLog = { message, time: now };
    process.stderr.write(`[alpha] alphaXiv MCP transient transport issue: ${message}\n`);
    return;
  }

  process.stderr.write(`[alpha] alphaXiv MCP error: ${message}\n`);
}

// Concurrent callers (searchAll, `--mode all`) share one connection; separate
// connections were never closed by disconnect() and kept the process alive.
async function getClient() {
  if (_client && _connected) return _client;
  _connecting ??= connectClient().finally(() => { _connecting = null; });
  return await _connecting;
}

async function connectClient() {
  const token = await getValidToken();
  if (!token) {
    throw new Error('Not logged in. Run `alpha login` first.');
  }

  _client = new Client({ name: 'alpha', version: '0.1.0' });

  _client.onerror = (err) => {
    if (isAuthError(err)) return; // callTool refreshes and retries
    if (isTransientTransportError(err)) {
      _connected = false;
    }
    logTransportError(err);
  };

  const transport = new StreamableHTTPClientTransport(new URL(ALPHAXIV_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  await _client.connect(transport);
  _connected = true;

  return _client;
}

// alphaXiv answers an expired or revoked token with HTTP 401 and
// {"error":{"message":"Invalid Authorization"}}, surfaced by the SDK as a
// StreamableHTTPError with code 401. Tool results are never auth errors.
function isAuthError(err) {
  if (err?.toolResult) return false;
  return err?.code === 401 || err?.name === 'UnauthorizedError' ||
    /Invalid Authorization|\b401\b|Unauthorized/.test(getErrorMessage(err));
}

const SESSION_EXPIRED = 'alphaXiv session expired. Run `alpha login` to sign in again.';

// Close only the connection that failed; a parallel caller may already have replaced it.
async function dropClient(client) {
  if (client && _client !== client) return;
  const stale = _client;
  _client = null;
  _connected = false;
  if (stale) {
    stale.onerror = () => {};
    try { await stale.close(); } catch {}
  }
}

async function callTool(name, args) {
  let refreshed = false;
  let transientRetries = 0;

  while (true) {
    let client;
    try {
      client = await getClient();
      const result = await client.callTool({ name, arguments: args });

      if (result.isError) {
        const toolError = new Error(result.content?.[0]?.text || 'Unknown error');
        toolError.toolResult = true;
        throw toolError;
      }

      const text = result.content?.[0]?.text;
      if (!text) return result.content;

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      if (isAuthError(err)) {
        // Refresh once (shared with any parallel caller) and retry once.
        if (refreshed) throw new Error(SESSION_EXPIRED);
        refreshed = true;
        await dropClient(client);
        if (!(await refreshAccessToken())) throw new Error(SESSION_EXPIRED);
        continue;
      }
      if (!isTransientTransportError(err) || ++transientRetries > 2) {
        throw err;
      }
      await dropClient(client);
    }
  }
}

function discoverArgs(query, difficulty) {
  const text = (typeof query === 'string' ? query : String(query ?? '')).trim();
  if (!text) throw new Error('Search query must not be empty.');
  return {
    keywords: text.split(/\s+/),
    question: text,
    difficulty,
  };
}

async function discoverPapers(query, difficulty) {
  const args = discoverArgs(query, difficulty);
  try {
    return await callTool('discover_papers', args);
  } catch (err) {
    // Only fall back when the MCP server no longer offers the tool; argument,
    // auth and transport errors must surface.
    if (!/\bTool discover_papers not found\b/i.test(getErrorMessage(err))) throw err;
    return await searchRestFast(args.question);
  }
}

// alphaXiv's public REST search; returns [{ link, paperId, title, snippet }].
async function searchRestFast(query) {
  const url = new URL(ALPHAXIV_REST_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('includePrivate', 'false');
  const token = await getValidToken();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`alphaXiv REST search failed (${response.status}): ${text || response.statusText}`);
  }
  return await response.json();
}

// The legacy `embedding_similarity_search`, `full_text_papers_search`, and
// `agentic_paper_retrieval` tools were removed from the alphaXiv MCP server
// and replaced by a single `discover_papers` tool. We preserve the original
// function names so existing callers keep working, mapping them to sensible
// `difficulty` levels.
export async function searchByEmbedding(query) {
  return await discoverPapers(query, 1);
}

export async function searchByKeyword(query) {
  return await discoverPapers(query, 1);
}

export async function agenticSearch(query) {
  return await discoverPapers(query, 3);
}

export async function searchAll(query) {
  // `semantic` and `keyword` both use difficulty 1 (consistent with their
  // individual wrappers). `agentic` uses difficulty 3 for multi-round search.
  // Both calls are issued in parallel and the difficulty-1 result is reused
  // for the two shallower keys to avoid a redundant third request.
  const [broad, agentic] = await Promise.all([
    discoverPapers(query, 1),
    discoverPapers(query, 3),
  ]);
  return { semantic: broad, keyword: broad, agentic };
}

export async function getPaperContent(url, { fullText = false } = {}) {
  const args = { url };
  if (fullText) args.fullText = true;
  return await callTool('get_paper_content', args);
}

export async function answerPdfQuery(url, query) {
  return await callTool('answer_pdf_queries', { paper: url, queries: [query] });
}

export async function readGithubRepo(githubUrl, path = '/') {
  return await callTool('read_files_from_github_repository', { githubUrl, path });
}

export async function disconnect() {
  if (_client) {
    _client.onerror = () => {};
    try {
      await _client.close();
    } catch {
    }
    _client = null;
    _connected = false;
  }
}

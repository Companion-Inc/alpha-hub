import {
  agenticSearch,
  answerPdfQuery,
  disconnect,
  getPaperContent,
  readGithubRepo,
  searchAll,
  searchByEmbedding,
  searchByKeyword,
} from './alphaxiv.js';
import {
  clearAnnotation,
  listAnnotations,
  readAnnotation,
  writeAnnotation,
} from './annotations.js';
import { getUserName, isLoggedIn, login, logout } from './auth.js';
import { isArxivId, normalizePaperId, toArxivUrl } from './papers.js';

export {
  disconnect,
  getUserName,
  isLoggedIn,
  login,
  logout,
  normalizePaperId,
  searchAll,
  searchByEmbedding,
  searchByKeyword,
  agenticSearch,
  readAnnotation,
  writeAnnotation,
  clearAnnotation,
  listAnnotations,
  readGithubRepo,
};

function parseMetricNumber(fragment, label) {
  const match = fragment.match(new RegExp(`(\\d+)\\s+${label}`, 'i'));
  return match ? Number(match[1]) : null;
}

function parsePublishedAt(fragment) {
  const match = fragment.match(/Published on ([^,]+)(?:,|$)/i);
  return match ? match[1].trim() : null;
}

function paperUrls(id) {
  if (!id) return { arxivUrl: null, alphaXivUrl: null };
  return {
    arxivUrl: isArxivId(id) ? `https://arxiv.org/abs/${id}` : null,
    alphaXivUrl: `https://www.alphaxiv.org/overview/${id}`,
  };
}

function cleanSearchField(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return normalized || null;
}

function normalizeStructuredSearchResult(entry, index, includeRaw) {
  const linkId = typeof entry.link === 'string' ? entry.link.replace(/^\/abs\//, '').trim() : '';
  const paperId = typeof entry.paperId === 'string' && entry.paperId.trim() ? entry.paperId.trim() : (linkId || null);
  const snippet = typeof entry.snippet === 'string' ? entry.snippet : (typeof entry.abstract === 'string' ? entry.abstract : null);
  return {
    rank: index + 1,
    title: cleanSearchField(typeof entry.title === 'string' ? entry.title : null),
    visits: null,
    likes: null,
    publishedAt: null,
    organizations: null,
    authors: cleanSearchField(typeof entry.authors === 'string' ? entry.authors : null),
    abstract: cleanSearchField(snippet),
    arxivId: cleanSearchField(paperId),
    ...paperUrls(cleanSearchField(paperId)),
    ...(includeRaw ? { raw: JSON.stringify(entry) } : {}),
  };
}

function parseStructuredSearchResults(payload, includeRaw) {
  const entries = Array.isArray(payload)
    ? payload
    : ['results', 'papers', 'data'].map((key) => payload?.[key]).find((value) => Array.isArray(value));
  if (!Array.isArray(entries)) {
    return null;
  }
  const results = entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => normalizeStructuredSearchResult(entry, index, includeRaw));
  return includeRaw ? { raw: JSON.stringify(payload), results } : { results };
}

export function parsePaperSearchResults(text, options = {}) {
  const includeRaw = options.includeRaw === true;
  if (typeof text !== 'string') {
    return parseStructuredSearchResults(text, includeRaw) ?? { results: [] };
  }

  // The new `discover_papers` tool returns one result per line in the form:
  //   `N. [ID=arxiv_id] **Title** [(source URL)]. Published YYYY-MM-DD[ by Orgs][ · N votes][ · N views]: Abstract...`
  // The legacy tools used a multi-line block format with explicit
  // `- arXiv Id:` / `- Organizations:` / `- Authors:` / `- Abstract:` fields.
  // We try the new format first and fall back to the legacy parser per block
  // so the public shape stays stable.

  const newFormatLine = /^(\d+)\.\s+\[ID=([^\]]+)\]\s+\*\*([\s\S]+?)\*\*(?:\s+\(https?:\/\/[^\s)]+\))?\.\s+Published\s+([\d-]+)(?:\s+by\s+([\s\S]+?))?(?:\s+·\s+([\d,]+)\s+votes)?(?:\s+·\s+([\d,]+)\s+views)?:\s*([\s\S]*)$/;

  const blocks = text
    .split(/\n(?=\d+\.\s+(?:\*\*|\[ID=))/g)
    .map((block) => block.trim())
    .filter(Boolean);

  const results = blocks.map((block, index) => {
    const newMatch = block.match(newFormatLine);
    if (newMatch) {
      const [, rankStr, arxivId, title, publishedAt, organizations, votes, views, abstract] = newMatch;
      return {
        rank: parseInt(rankStr, 10),
        visits: views === undefined ? null : Number(views.replaceAll(',', '')),
        likes: votes === undefined ? null : Number(votes.replaceAll(',', '')),
        authors: null,
        title: cleanSearchField(title),
        publishedAt: cleanSearchField(publishedAt),
        organizations: cleanSearchField(organizations || null),
        abstract: cleanSearchField(abstract),
        arxivId: cleanSearchField(arxivId),
        ...paperUrls(cleanSearchField(arxivId)),
        ...(includeRaw ? { raw: block } : {}),
      };
    }

    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const header = lines[0] || '';
    const headerMatch = header.match(/^\d+\.\s+\*\*(.+?)\*\*\s+\((.+)\)$/);

    const fieldValue = (prefix) => {
      const line = lines.find((entry) => entry.startsWith(prefix));
      return line ? line.slice(prefix.length).trim() : null;
    };

    const arxivId = fieldValue('- arXiv Id:');

    return {
      rank: index + 1,
      title: cleanSearchField(headerMatch ? headerMatch[1] : header),
      visits: headerMatch ? parseMetricNumber(headerMatch[2], 'Visits') : null,
      likes: headerMatch ? parseMetricNumber(headerMatch[2], 'Likes') : null,
      publishedAt: headerMatch ? parsePublishedAt(headerMatch[2]) : null,
      organizations: cleanSearchField(fieldValue('- Organizations:')),
      authors: cleanSearchField(fieldValue('- Authors:')),
      abstract: cleanSearchField(fieldValue('- Abstract:')),
      arxivId: cleanSearchField(arxivId),
      ...paperUrls(cleanSearchField(arxivId)),
      ...(includeRaw ? { raw: block } : {}),
    };
  });

  return includeRaw ? { raw: text, results } : { results };
}

function normalizeSearchPayload(query, mode, payload, options = {}) {
  if (mode === 'all' || mode === 'both') {
    // Use a Map keyed on the raw value so identical strings (e.g. the shared
    // difficulty-1 result under both `semantic` and `keyword`) are only parsed
    // once rather than once per key.
    const parseCache = new Map();
    const normalized = {};
    for (const [key, value] of Object.entries(payload)) {
      if (!parseCache.has(value)) {
        parseCache.set(value, parsePaperSearchResults(value, options));
      }
      normalized[key] = parseCache.get(value);
    }
    return {
      query,
      mode,
      ...normalized,
    };
  }

  const parsed = parsePaperSearchResults(payload, options);
  return {
    query,
    mode,
    ...parsed,
  };
}

export async function searchPapers(query, mode = 'semantic', options = {}) {
  if (mode === 'keyword') return normalizeSearchPayload(query, mode, await searchByKeyword(query), options);
  if (mode === 'agentic') return normalizeSearchPayload(query, mode, await agenticSearch(query), options);
  if (mode === 'both') {
    // `discover_papers` replaces both semantic and keyword search, so we
    // make a single request and reuse it under both keys.
    const result = await searchByEmbedding(query);
    return normalizeSearchPayload(query, mode, { semantic: result, keyword: result }, options);
  }
  if (mode === 'all') return normalizeSearchPayload(query, mode, await searchAll(query), options);
  return normalizeSearchPayload(query, mode, await searchByEmbedding(query), options);
}

export async function getPaper(identifier, options = {}) {
  const paperId = normalizePaperId(identifier);
  const url = toArxivUrl(identifier);
  const content = await getPaperContent(url, { fullText: Boolean(options.fullText) });
  const annotation = readAnnotation(paperId);
  return {
    paperId,
    url,
    alphaXivUrl: `https://www.alphaxiv.org/overview/${paperId}`,
    content,
    annotation,
  };
}

export async function askPaper(identifier, question) {
  const paperId = normalizePaperId(identifier);
  const url = toArxivUrl(identifier);
  const answer = await answerPdfQuery(url, question);
  return {
    paperId,
    url,
    alphaXivUrl: `https://www.alphaxiv.org/overview/${paperId}`,
    question,
    answer,
  };
}

export async function annotatePaper(identifier, note) {
  const paperId = normalizePaperId(identifier);
  const annotation = writeAnnotation(paperId, note);
  return { status: 'saved', annotation };
}

export async function clearPaperAnnotation(identifier) {
  const paperId = normalizePaperId(identifier);
  const cleared = clearAnnotation(paperId);
  return { status: cleared ? 'cleared' : 'not_found', paperId };
}

export async function getPaperAnnotation(identifier) {
  const paperId = normalizePaperId(identifier);
  const annotation = readAnnotation(paperId);
  return annotation ? { status: 'found', annotation } : { status: 'no_annotation', paperId };
}

export async function listPaperAnnotations() {
  const annotations = listAnnotations();
  return { total: annotations.length, annotations };
}

export async function readPaperCode(githubUrl, path = '/') {
  return readGithubRepo(githubUrl, path);
}

// New-style (2401.00001v2) and old-style (hep-th/9901001) arXiv identifiers.
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i;

export function isArxivId(id) {
  return typeof id === 'string' && ARXIV_ID.test(id);
}

export function normalizePaperId(input) {
  const patterns = [
    /arxiv\.org\/abs\/(\d+\.\d+)/,
    /arxiv\.org\/pdf\/(\d+\.\d+)/,
    /alphaxiv\.org\/(?:abs|overview)\/(\d+\.\d+)(?:v\d+)?(?:[/?#]|$)/,
    /alphaxiv\.org\/(?:abs|overview)\/([^/?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }

  return input;
}

// arXiv IDs resolve to arXiv; other bare IDs are alphaXiv-hosted papers, whose
// IDs (e.g. 2607.some-paper-title) appear in search results.
export function toArxivUrl(input) {
  const id = normalizePaperId(input);
  if (isArxivId(id)) return `https://arxiv.org/abs/${id}`;
  if (input.startsWith('http')) return input;
  return `https://www.alphaxiv.org/abs/${id}`;
}

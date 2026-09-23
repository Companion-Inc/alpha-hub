# Alpha Hub

Research agents hallucinate paper details and forget what they learn in a session. Alpha Hub gives them semantic paper search, AI-generated reports, and persistent annotations — so they get smarter with every task. Search and content powered by [alphaXiv](https://alphaxiv.org).

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.22.0-brightgreen)](https://nodejs.org)

## Quick Start

Requires Node.js **22.22.0 or newer**.

```bash
npm install -g @companion-ai/alpha-hub
alpha login                        # sign in with alphaXiv
alpha status                       # show whether alphaXiv auth is present
alpha search "attention mechanism" # search papers
alpha get 1706.03762               # fetch paper report
```

If you installed the interim `@advaitpaliwal/alpha-hub` package, migrate once:

```bash
npm uninstall -g @advaitpaliwal/alpha-hub
npm install -g @companion-ai/alpha-hub
```

The commands remain `alpha` and `alpha-mcp`. Library consumers should use the `@companion-ai/alpha-hub` dependency and import scope; export paths such as `/lib` and `/lib/auth` are unchanged.

## Login

`alpha login` signs in with alphaXiv's OAuth server and stores tokens in `~/.ahub/auth.json` (readable only by you). It opens your browser and waits for alphaXiv to redirect back to `http://127.0.0.1:9876/callback`.

**Remote servers, SSH, containers, WSL:** if the browser runs on a different machine, it cannot reach that callback. Open the printed login URL in any browser, sign in, and copy the address the browser ends on (`http://127.0.0.1:9876/callback?code=...&state=...`, even if the page fails to load). Paste it into the waiting `alpha login` and press Enter. The pasted URL must come from the same login attempt. Login waits up to 5 minutes.

## How It Works

Alpha is designed for your coding agent to use (not for you to use!). You can prompt your agent to use it (e.g., "Use the CLI command `alpha` to search for papers on LoRA. Run `alpha` to see how it works.")

**Most of the time, it's simple — search, read, use:**

```bash
alpha search "transformer attention"     # find relevant papers
alpha get 1706.03762                     # fetch AI-generated paper report
# Agent reads the report, understands the paper. Done.
```

**When the agent discovers something useful**, it can annotate locally for next time:

```bash
alpha annotate 1706.03762 "Superseded by Flash Attention for efficiency"

# Next session, the annotation appears automatically on alpha get.
```

**Need to go deeper?** Ask questions about any paper:

```bash
alpha ask 1706.03762 "What datasets were used for evaluation?"
```

## Commands

| Command | Purpose |
|---------|---------|
| `alpha search <query>` | Search papers (`--mode semantic\|keyword\|both\|agentic\|all`) |
| `alpha get <id\|url>` | Fetch paper report + local annotation |
| `alpha ask <id\|url> <question>` | Ask a question about a paper |
| `alpha code <github-url> [path]` | Read files from a paper repository |
| `alpha annotate <id> <note>` | Attach a note to a paper |
| `alpha annotate <id> --clear` | Remove a note |
| `alpha annotate --list` | List all notes |
| `alpha login` | Sign in with alphaXiv |
| `alpha status` | Check the alphaXiv login with alphaXiv (exit 1 if missing, expired, or unverifiable) |
| `alpha logout` | Sign out |

All commands accept `--json` for machine-readable output.

## Self-Improving Agents

Alpha Hub is designed for a loop where agents get better over time.

**Annotations** are local notes that agents attach to papers. They persist across sessions and appear automatically on future fetches — so agents learn from past experience.

```
  Without Alpha Hub                          With Alpha Hub
  ─────────────────                          ──────────────
  Search the web for papers                  Semantic search via alphaXiv
  Read raw PDFs                              AI-generated paper reports
  Miss context and gotchas                   Agent notes what it learns
  Knowledge forgotten                        ↗ Even smarter next session
  ↻ Repeat next session
```

## Key Features

### Paper Search

Search uses alphaXiv's `discover_papers` tool. `semantic` (default) and `keyword` run the standard search; alphaXiv no longer has separate embedding and full-text tools, so both names give the same results. `agentic` runs a slower multi-round search. `both` and `all` return results under the `semantic`, `keyword`, and `agentic` keys.

Results show the paper ID. Most are arXiv IDs. Papers hosted only on alphaXiv have IDs such as `2607.some-paper-title`. `alpha get` and `alpha ask` accept both.

```bash
alpha search "speculative decoding"
alpha search "retrieval-augmented generation for QA" --mode agentic
alpha search "alignment of vision language models" --mode all --json
```

### Paper Q&A

Ask questions about any paper without reading the full PDF. The answer is grounded in the paper's actual content.

```bash
alpha ask 2106.09685 "What is the rank used for the low-rank matrices?"
```

### Annotations

Local notes that agents attach to papers — they persist across sessions and appear automatically on future fetches. See the annotation as a gap the agent discovered and recorded so it doesn't repeat the same mistake.

### Repository Reading

Read files directly from a paper's GitHub repository when the implementation matters.

```bash
alpha code https://github.com/openai/gpt-2 /
alpha code https://github.com/openai/gpt-2 src/model.py
```

## Library

```js
import { searchPapers, getPaper, askPaper, disconnect } from '@companion-ai/alpha-hub/lib';

const { results } = await searchPapers('speculative decoding'); // [{ rank, title, arxivId, arxivUrl, alphaXivUrl, abstract, ... }]
const paper = await getPaper(results[0].arxivId);                // { paperId, url, alphaXivUrl, content, annotation }
await disconnect();
```

| Import | Exports |
|--------|---------|
| `@companion-ai/alpha-hub/lib` | `searchPapers`, `parsePaperSearchResults`, `getPaper`, `askPaper`, `readPaperCode`, `annotatePaper`, `getPaperAnnotation`, `clearPaperAnnotation`, `listPaperAnnotations`, `normalizePaperId`, `login`, `logout`, `isLoggedIn`, `getUserName`, `disconnect`, and the raw `searchByEmbedding`, `searchByKeyword`, `agenticSearch`, `searchAll`, `readGithubRepo`, `readAnnotation`, `writeAnnotation`, `clearAnnotation`, `listAnnotations` |
| `@companion-ai/alpha-hub/lib/auth` | `login`, `logout`, `isLoggedIn` (stored tokens only), `verifyLogin` (asks alphaXiv), `getAccessToken`, `getValidToken`, `refreshAccessToken`, `getUserId`, `getUserName` |
| `@companion-ai/alpha-hub/lib/alphaxiv` | Raw alphaXiv MCP calls: `getPaperContent`, `answerPdfQuery`, `readGithubRepo`, the search functions, `disconnect` |
| `@companion-ai/alpha-hub/lib/papers` | `normalizePaperId`, `toArxivUrl`, `isArxivId` |
| `@companion-ai/alpha-hub/lib/annotations` | `readAnnotation`, `writeAnnotation`, `clearAnnotation`, `listAnnotations` |

Call `disconnect()` when you are done to close the alphaXiv MCP connection. `alpha-mcp` runs the same tools as a stdio MCP server (`alpha_search`, `alpha_get`, `alpha_ask`, `alpha_code`, `alpha_annotate`).

## License

[MIT](LICENSE)

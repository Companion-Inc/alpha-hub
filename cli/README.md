# Alpha Hub

Unofficial alphaXiv-powered CLI and library for research agents.

## Install

Requires Node.js **22.22.0 or newer**.

```bash
npm install -g @companion-ai/alpha-hub
```

If you installed the interim `@advaitpaliwal/alpha-hub` package, migrate once:

```bash
npm uninstall -g @advaitpaliwal/alpha-hub
npm install -g @companion-ai/alpha-hub
```

The commands remain `alpha` and `alpha-mcp`. Library consumers should use the `@companion-ai/alpha-hub` dependency and import scope; export paths such as `/lib` and `/lib/auth` are unchanged.

## Quick Start

```bash
alpha login
alpha status
alpha search "attention mechanism"
alpha get 1706.03762
alpha ask 1706.03762 "What datasets were used for evaluation?"
alpha code https://github.com/openai/gpt-2 /
```

`alpha login` opens a browser and waits for the redirect to `http://127.0.0.1:9876/callback`. On a remote server, over SSH, or in a container, open the printed URL in any browser. After you sign in, paste the address the browser ends on (`http://127.0.0.1:9876/callback?code=...`) into the waiting terminal.

## Package Exports

This package exposes:

- `alpha` CLI
- `alpha-mcp` CLI (stdio MCP server)
- library helpers from `@companion-ai/alpha-hub/lib` (`searchPapers`, `getPaper`, `askPaper`, annotations, auth), plus `/lib/auth`, `/lib/alphaxiv`, `/lib/papers`, and `/lib/annotations`

See the [repository README](https://github.com/Companion-Inc/alpha-hub#library) for the full export list.

## 0.1.6

- `alpha login` ignores a callback or pasted URL whose OAuth state is not this login's (it answers 400 and keeps waiting) instead of aborting. An `?error=` with the matching state still ends the login.
- Token refreshes are shared within a process, so parallel requests no longer race refresh-token rotation. A refresh no longer overwrites `auth.json` if you logged out, or another process refreshed or logged in, while it was running.
- An expired or revoked access token no longer fails alphaXiv calls. Previously, about an hour after login, long-running processes that kept one connection failed with `Streamable HTTP error: Error POSTing to endpoint: {"error":{"message":"Invalid Authorization"}}`, which was not recognized as an auth error. Now any call that gets this error refreshes the token once (shared with parallel calls), reconnects and retries once. If that fails, it reports `alphaXiv session expired. Run \`alpha login\` to sign in again.`
- `alpha status` now checks the login with alphaXiv (`oauth2/userinfo`, trying one token refresh if the token is rejected). It exits 1 when not logged in, when the session has expired, or when alphaXiv cannot be reached. The library's `isLoggedIn()` still only checks for stored tokens. The new `verifyLogin()` in `/lib/auth` does the server check.
- `auth.json` is replaced atomically: a new owner-only file is written next to it and renamed over it.

## 0.1.5

- `alpha login` accepts the pasted redirect URL when the browser cannot reach the local callback, for example on headless servers, SSH sessions, containers, and WSL. The OAuth state check still applies. On Linux without a display, `alpha login` no longer tries to open a browser. On WSL it tries `wslview` and then the Windows default browser. The login wait is now 5 minutes.
- `~/.ahub/auth.json` is written with owner-only permissions.
- `alpha get` and `alpha ask` accept alphaXiv-hosted paper IDs from search results, such as `2607.some-paper-title`. Search results give these papers `arxivUrl: null`.
- If alphaXiv removes the `discover_papers` MCP tool, search falls back to alphaXiv's REST search.
- `alpha search --mode both` and `--mode all` no longer hang after printing results, and no longer send duplicate requests. Library callers that ran searches in parallel also share one connection now.

# Alpha Hub

Unofficial alphaXiv-powered CLI and library for research agents.

## Install

Requires Node.js **22.22.0 or newer**. Version 0.1.4 uses MCP SDK 1.30, Chalk 6, Commander 15, and Zod 4.

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

## Package Exports

This package exposes:

- `alpha` CLI
- `alpha-mcp` CLI
- library helpers from `@companion-ai/alpha-hub/lib`

Repository:
https://github.com/Companion-Inc/alpha-hub

## 0.1.4: paper-access repairs

- The package is published as `@companion-ai/alpha-hub` from `Companion-Inc/alpha-hub` (0.1.4 was also briefly published as `@advaitpaliwal/alpha-hub`); CLI names and library export paths remain compatible.
- Login uses alphaXiv's current OAuth issuer, requests OpenID scopes, and validates callback state.
- Existing search functions use `discover_papers` with array keywords and numeric difficulty instead of removed tools. Combined modes retain their result keys.
- Paper results support current discovery text, legacy text, and structured JSON; paper Q&A uses the maintained `paper`/`queries` payload.

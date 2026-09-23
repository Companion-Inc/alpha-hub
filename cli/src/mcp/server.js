import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { handleSearch, handleGet, handleAsk, handleAnnotate, handleCode } from './tools.js';

const _stderr = process.stderr;
console.log = (...args) => _stderr.write(args.join(' ') + '\n');
console.warn = (...args) => _stderr.write('[warn] ' + args.join(' ') + '\n');
console.info = (...args) => _stderr.write('[info] ' + args.join(' ') + '\n');
console.debug = (...args) => _stderr.write('[debug] ' + args.join(' ') + '\n');

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

const server = new McpServer({
  name: 'alpha',
  version: pkg.version,
});

server.tool(
  'alpha_search',
  'Search research papers via alphaXiv. semantic and keyword run a standard search; agentic runs a slower multi-round search.',
  {
    query: z.string().describe('What you are looking for, in plain terms'),
    mode: z.enum(['semantic', 'keyword', 'agentic']).optional().describe('Search mode (default: semantic)'),
  },
  async (args) => handleSearch(args),
);

server.tool(
  'alpha_get',
  'Get paper content and local annotation. Accepts arXiv URL, alphaXiv URL, or arXiv ID.',
  {
    url: z.string().describe('arXiv/alphaXiv URL or arXiv ID (e.g. "2106.09685")'),
    full_text: z.boolean().optional().describe('Get raw text instead of AI-generated report (default: false)'),
  },
  async (args) => handleGet(args),
);

server.tool(
  'alpha_ask',
  'Ask a question about a specific paper. Uses AI to analyze the PDF and answer.',
  {
    url: z.string().describe('arXiv/alphaXiv URL or arXiv ID'),
    question: z.string().describe('Question about the paper'),
  },
  async (args) => handleAsk(args),
);

server.tool(
  'alpha_annotate',
  'Read, write, clear, or list local annotations on papers. Annotations persist across sessions and appear on future fetches.',
  {
    id: z.string().optional().describe('Paper ID (arXiv ID or URL). Required unless using list mode.'),
    note: z.string().optional().describe('Annotation text to save. Omit to read existing.'),
    clear: z.boolean().optional().describe('Remove annotation for this paper'),
    list: z.boolean().optional().describe('List all annotations'),
  },
  async (args) => handleAnnotate(args),
);

server.tool(
  'alpha_code',
  "Read files from a paper's GitHub repository. Use path '/' for repo overview.",
  {
    github_url: z.string().describe('GitHub repository URL'),
    path: z.string().optional().describe("File or directory path (default: '/')"),
  },
  async (args) => handleCode(args),
);

process.on('uncaughtException', (err) => {
  _stderr.write(`[alpha-mcp] Uncaught exception: ${err.message}\n`);
});
process.on('unhandledRejection', (reason) => {
  _stderr.write(`[alpha-mcp] Unhandled rejection: ${reason}\n`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
_stderr.write(`[alpha-mcp] Server started (v${pkg.version})\n`);

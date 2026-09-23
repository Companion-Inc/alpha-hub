// Compile-only fixture, copied into an ordinary installed consumer for qualification.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  searchPapers, parsePaperSearchResults, askPaper, annotatePaper, normalizePaperId,
} from '@companion-ai/alpha-hub/lib';
import { isLoggedIn } from '@companion-ai/alpha-hub/lib/auth';

const loggedIn: boolean = isLoggedIn();
const paperId: string = normalizePaperId('2401.00001');
const parsed: { results: unknown[]; raw?: unknown } = parsePaperSearchResults([], { includeRaw: true });
const server = new McpServer({ name: 'type-compatibility-fixture', version: '1.0.0' });
server.tool('search_fixture', 'Compile the existing Zod raw-shape API', {
  query: z.string(),
  mode: z.enum(['semantic', 'keyword', 'agentic']).optional(),
}, async ({ query, mode }) => ({
  content: [{ type: 'text', text: JSON.stringify(await searchPapers(query, mode)) }],
}));

const answer: ReturnType<typeof askPaper> = askPaper(paperId, 'What evidence is present?');
const annotation: ReturnType<typeof annotatePaper> = annotatePaper(paperId, 'Compile-only fixture');
void [loggedIn, parsed, answer, annotation];
// @ts-expect-error Public search helpers require a string query.
void searchPapers(123);

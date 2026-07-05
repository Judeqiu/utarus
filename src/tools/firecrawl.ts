import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v2';

function getApiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    throw new Error('FIRECRAWL_API_KEY not set in environment');
  }
  return key;
}

async function firecrawlRequest(
  endpoint: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const apiKey = getApiKey();
  const response = await fetch(`${FIRECRAWL_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Firecrawl API error (${response.status}): ${error}`);
  }

  return response.json();
}

const paramsSchema = Type.Object({
  action: Type.Union([
    Type.Literal('search'),
    Type.Literal('scrape'),
    Type.Literal('ask'),
    Type.Literal('docs-search'),
  ], { description: 'Firecrawl action to perform' }),
  query: Type.Optional(Type.String({ description: 'Search query or URL to scrape' })),
  url: Type.Optional(Type.String({ description: 'URL to scrape (for scrape action)' })),
  question: Type.Optional(Type.String({ description: 'Question to ask (for ask/docs-search actions)' })),
  jobId: Type.Optional(Type.String({ description: 'Job ID for ask action' })),
  limit: Type.Optional(Type.Number({ description: 'Max results for search (default 10)' })),
});

export function createFirecrawlTool(): AgentTool<typeof paramsSchema, unknown> {
  return {
    name: 'firecrawl',
    label: 'Firecrawl',
    description: `Search the web, scrape pages, or ask questions about web content. Use for competitor research, pricing lookups, or any task requiring live web data.

Actions:
- search: Find pages by query (provide query)
- scrape: Extract clean markdown from a URL (provide url)
- ask: Diagnose a failing Firecrawl job (provide jobId + question)
- docs-search: Search Firecrawl documentation (provide question)`,
    parameters: paramsSchema,
    async execute(_id, params) {
      const { action, query, url, question, jobId, limit } = params as {
        action: string;
        query?: string;
        url?: string;
        question?: string;
        jobId?: string;
        limit?: number;
      };

      try {
        let result: unknown;

        switch (action) {
          case 'search':
            if (!query) throw new Error('query is required for search');
            result = await firecrawlRequest('/search', {
              query,
              limit: limit ?? 10,
            });
            break;

          case 'scrape':
            if (!url) throw new Error('url is required for scrape');
            result = await firecrawlRequest('/scrape', { url });
            break;

          case 'ask':
            if (!question) throw new Error('question is required for ask');
            result = await firecrawlRequest('/support/ask', {
              question,
              jobId,
            });
            break;

          case 'docs-search':
            if (!question) throw new Error('question is required for docs-search');
            result = await firecrawlRequest('/support/docs-search', {
              question,
            });
            break;

          default:
            throw new Error(`Unknown action: ${action}`);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          details: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `❌ Firecrawl error: ${message}` }],
          details: null,
        };
      }
    },
  };
}

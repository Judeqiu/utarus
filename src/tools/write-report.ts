import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../');

function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

const productSchema = Type.Object({
  rank: Type.Number(),
  name: Type.String(),
  merchant: Type.String(),
  price: Type.String(),
  price_value: Type.Number({ description: 'Numeric price for calculations' }),
  discount: Type.Optional(Type.String()),
  rating: Type.Optional(Type.String()),
  url: Type.String({ description: 'Direct product listing URL on the marketplace (e.g. https://www.ebay.com/itm/123, https://shopee.sg/product/...). MUST be the product page URL, NOT the source article URL where data was scraped from.' }),
  badge: Type.Optional(Type.String({ description: 'e.g. "Official Store", "Reseller"' })),
});

const merchantSchema = Type.Object({
  name: Type.String(),
  type: Type.String({ description: 'e.g. "Official Store", "Reseller", "Brand Store"' }),
  avg_price: Type.String(),
  items_count: Type.Optional(Type.Number()),
  badge: Type.Optional(Type.String({ description: '"gold", "silver", or "self"' })),
});

const metricSchema = Type.Object({
  label: Type.String(),
  value: Type.String(),
  subtitle: Type.Optional(Type.String()),
  highlight: Type.Optional(Type.Boolean({ description: 'True for "Your Price" card' })),
  color: Type.Optional(Type.String({ description: '"green", "orange", "red", or "default"' })),
});

const paramsSchema = Type.Object({
  title: Type.String({ description: 'Report title, e.g. "MacBook Air M5 - Price Benchmark"' }),
  slug: Type.String({ description: 'URL-safe slug for filename, e.g. "macbook-air-m5-shopee"' }),
  owner_slug: Type.String({ description: 'Owner slug to save report to their BinDrive folder (data/drive/<owner_slug>/).' }),
  market: Type.String({ description: 'Marketplace, e.g. "Shopee Singapore", "eBay US"' }),
  category: Type.String({ description: 'Product category, e.g. "electronics", "fashion"' }),
  date: Type.String({ description: 'Report date, e.g. "2026-06-21"' }),
  metrics: Type.Array(metricSchema, { description: 'Key metric cards (3-5 recommended)' }),
  products: Type.Array(productSchema, { description: 'Product listings ranked by sales' }),
  merchants: Type.Array(merchantSchema, { description: 'Top merchants leaderboard' }),
  sources: Type.Optional(Type.Array(Type.Object({
    name: Type.String(),
    url: Type.String(),
    scraped: Type.String(),
  }), { description: 'Data sources used' })),
  disposition: Type.Optional(Type.String({ description: 'HOLD, ADVISE, or ACT' })),
  recommendations: Type.Optional(Type.Array(Type.String(), { description: 'Action items' })),
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMetricCard(m: { label: string; value: string; subtitle?: string; highlight?: boolean; color?: string }): string {
  const borderColor = m.highlight ? 'border-green-500' : 'border-gray-200';
  const valueColor = m.color === 'green' ? 'text-green-600' : m.color === 'orange' ? 'text-orange-600' : m.color === 'red' ? 'text-red-600' : 'text-gray-900';
  const subtitleColor = m.highlight ? 'text-green-600' : 'text-gray-500';
  return `
    <div class="bg-white rounded-xl p-4 card-shadow hover-lift border-2 ${borderColor}">
      <p class="text-xs text-gray-500 uppercase tracking-wide">${escapeHtml(m.label)}</p>
      <p class="text-2xl font-bold ${valueColor} mt-1">${escapeHtml(m.value)}</p>
      ${m.subtitle ? `<p class="text-xs ${subtitleColor} mt-1">${escapeHtml(m.subtitle)}</p>` : ''}
    </div>`;
}

function renderProductRow(p: { rank: number; name: string; merchant: string; price: string; discount?: string; rating?: string; url: string; badge?: string }): string {
  const nameCell = `<a href="${escapeHtml(p.url)}" target="_blank" class="text-blue-600 hover:underline font-medium">${escapeHtml(p.name)}</a>`;
  return `
    <tr class="hover:bg-gray-50">
      <td class="px-4 py-3 text-sm text-gray-500">${p.rank}</td>
      <td class="px-4 py-3">${nameCell}</td>
      <td class="px-4 py-3 text-sm text-gray-600 hide-mobile">${escapeHtml(p.merchant)}${p.badge ? ` <span class="text-xs text-gray-400">(${escapeHtml(p.badge)})</span>` : ''}</td>
      <td class="px-4 py-3 text-sm font-semibold text-gray-900">${escapeHtml(p.price)}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${p.discount ? escapeHtml(p.discount) : '—'}</td>
      <td class="px-4 py-3 text-sm text-gray-600 hide-mobile">${p.rating ? escapeHtml(p.rating) : '—'}</td>
      <td class="px-4 py-3 text-sm"><a href="${escapeHtml(p.url)}" target="_blank" class="text-blue-600 hover:underline whitespace-nowrap">View ↗</a></td>
    </tr>`;
}

function renderMerchantCard(m: { name: string; type: string; avg_price: string; items_count?: number; badge?: string }, index: number): string {
  const medals = ['🥇', '🥈', '🥉'];
  const medal = medals[index] || `#${index + 1}`;
  const isSelf = m.badge === 'self';
  const borderClass = isSelf ? 'border-2 border-green-500 bg-green-50' : index === 0 ? 'border-l-4 border-yellow-400' : 'border-l-4 border-gray-400';
  const iconBg = isSelf ? 'bg-green-100' : index === 0 ? 'bg-yellow-100' : 'bg-gray-100';
  return `
    <div class="bg-white rounded-xl p-4 card-shadow ${borderClass}">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 ${iconBg} rounded-full flex items-center justify-center text-xl">${medal}</div>
        <div>
          <p class="font-semibold text-gray-900">${escapeHtml(m.name)}</p>
          <p class="text-xs ${isSelf ? 'text-green-600' : 'text-gray-500'}">${escapeHtml(m.type)}</p>
          <p class="text-sm ${isSelf ? 'text-green-700 font-bold' : 'text-gray-600'} mt-1">${escapeHtml(m.avg_price)}${isSelf ? ' ✅' : ''}</p>
          ${m.items_count ? `<p class="text-xs text-gray-400">${m.items_count} items</p>` : ''}
        </div>
      </div>
    </div>`;
}

function generateDashboardHtml(data: {
  title: string;
  market: string;
  category: string;
  date: string;
  metrics: Array<{ label: string; value: string; subtitle?: string; highlight?: boolean; color?: string }>;
  products: Array<{ rank: number; name: string; merchant: string; price: string; discount?: string; rating?: string; url: string; badge?: string }>;
  merchants: Array<{ name: string; type: string; avg_price: string; items_count?: number; badge?: string }>;
  sources?: Array<{ name: string; url: string; scraped: string }>;
  disposition?: string;
  recommendations?: string[];
}): string {
  const metricsHtml = data.metrics.map(renderMetricCard).join('\n');
  const productsHtml = data.products.map(renderProductRow).join('\n');
  const merchantsHtml = data.merchants.map((m, i) => renderMerchantCard(m, i)).join('\n');

  const sourcesSection = data.sources?.length ? `
    <div class="mt-6 bg-white rounded-xl p-4 card-shadow">
      <h3 class="text-lg font-semibold text-gray-900 mb-3">Data Sources</h3>
      <table class="w-full text-sm">
        <thead class="bg-gray-50"><tr>
          <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
          <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">URL</th>
          <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Scraped</th>
        </tr></thead>
        <tbody class="divide-y divide-gray-200">
          ${data.sources!.map(s => `<tr><td class="px-3 py-2">${escapeHtml(s.name)}</td><td class="px-3 py-2 text-blue-600"><a href="${escapeHtml(s.url)}" target="_blank">${escapeHtml(s.url)}</a></td><td class="px-3 py-2 text-gray-500">${escapeHtml(s.scraped)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const dispositionColor = data.disposition === 'ACT' ? 'text-red-600 bg-red-50 border-red-200' : data.disposition === 'ADVISE' ? 'text-yellow-600 bg-yellow-50 border-yellow-200' : 'text-green-600 bg-green-50 border-green-200';

  const recommendationsSection = data.recommendations?.length ? `
    <div class="mt-6 bg-white rounded-xl p-4 card-shadow">
      <h3 class="text-lg font-semibold text-gray-900 mb-3">Recommendations</h3>
      <ul class="space-y-2">
        ${data.recommendations.map(r => `<li class="flex items-start space-x-2 text-sm"><span class="text-blue-500 mt-0.5">→</span><span>${escapeHtml(r)}</span></li>`).join('')}
      </ul>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(data.title)} — Binary Intelligence</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { font-family: 'Inter', sans-serif; }
  .card-shadow { box-shadow: 0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06); }
  .hover-lift { transition: transform 0.2s, box-shadow 0.2s; }
  .hover-lift:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
  @media (max-width: 640px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .hide-mobile { display: none; }
  }
  @media (min-width: 641px) and (max-width: 1024px) {
    .stats-grid { grid-template-columns: repeat(3, 1fr); }
  }
  @media (min-width: 1025px) {
    .stats-grid { grid-template-columns: repeat(5, 1fr); }
  }
</style>
</head>
<body class="bg-gray-50 min-h-screen">
  <header class="bg-white border-b border-gray-200 sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <div class="flex items-center space-x-3">
          <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
            <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
            </svg>
          </div>
          <div>
            <h1 class="text-xl font-bold text-gray-900">${escapeHtml(data.title)}</h1>
            <p class="text-xs text-gray-500">${escapeHtml(data.market)} — ${escapeHtml(data.category)} • ${escapeHtml(data.date)}</p>
          </div>
        </div>
        <div class="flex items-center space-x-2">
          ${data.disposition ? `<span class="px-3 py-1 rounded-full text-sm font-medium border ${dispositionColor}">${escapeHtml(data.disposition)}</span>` : ''}
          <span class="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium">Binary Intelligence</span>
        </div>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
    <div class="stats-grid gap-4 mb-6">
      ${metricsHtml}
    </div>

    <div class="bg-white rounded-xl card-shadow overflow-hidden">
      <div class="p-4 border-b border-gray-200">
        <h3 class="text-lg font-semibold text-gray-900">${escapeHtml(data.title)} — Top Products</h3>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">#</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hide-mobile">Merchant</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Discount</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase hide-mobile">Rating</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Link</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200">
            ${productsHtml}
          </tbody>
        </table>
      </div>
    </div>

    <div class="mt-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-4">Top Merchants</h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        ${merchantsHtml}
      </div>
    </div>

    ${sourcesSection}
    ${recommendationsSection}
  </main>

  <footer class="border-t border-gray-200 mt-12 py-6 text-center text-sm text-gray-400">
    Generated by Binary — AI Seller Account Manager • Data collected via Firecrawl • ${escapeHtml(data.date)}
  </footer>
</body>
</html>`;
}

type ReportDetails = { path: string; slug: string };

export function createWriteReportTool(): AgentTool<typeof paramsSchema, ReportDetails> {
  return {
    name: 'write_report',
    label: 'Write Report',
    description: `Generate an HTML intelligence dashboard from structured competition data. Use after collecting marketplace data via firecrawl to produce a visual report.

REQUIRED: Always include owner_slug to save to the seller's BinDrive folder (data/drive/<owner_slug>/). Never omit owner_slug — reports must always be saved to a seller's drive.

The report includes: key metrics cards, product ranking table, top merchants leaderboard, data sources, and recommendations. The HTML is a self-contained file (Tailwind CDN) that can be opened in any browser.`,
    parameters: paramsSchema,
    async execute(_id, raw) {
      const p = raw as {
        title: string;
        slug: string;
        owner_slug: string;
        market: string;
        category: string;
        date: string;
        metrics: Array<{ label: string; value: string; subtitle?: string; highlight?: boolean; color?: string }>;
        products: Array<{ rank: number; name: string; merchant: string; price: string; price_value: number; discount?: string; rating?: string; url: string; badge?: string }>;
        merchants: Array<{ name: string; type: string; avg_price: string; items_count?: number; badge?: string }>;
        sources?: Array<{ name: string; url: string; scraped: string }>;
        disposition?: string;
        recommendations?: string[];
      };

      try {
        if (!p.slug || !/^[a-z0-9][a-z0-9-]*$/.test(p.slug)) {
          return { content: [{ type: 'text', text: '❌ slug must be lowercase kebab-case [a-z0-9-]+' }], details: { path: '', slug: '' } };
        }
        if (!p.owner_slug) {
          return { content: [{ type: 'text', text: '❌ owner_slug is required. Always save reports to the owner entity\'s BinDrive folder (data/drive/<owner_slug>/).' }], details: { path: '', slug: '' } };
        }
        if (!p.metrics?.length) return { content: [{ type: 'text', text: '❌ metrics array is required (3-5 key metric cards)' }], details: { path: '', slug: '' } };
        if (!p.products?.length) return { content: [{ type: 'text', text: '❌ products array is required (at least 1 product)' }], details: { path: '', slug: '' } };
        const missingUrl = p.products.filter(x => !x.url);
        if (missingUrl.length) return { content: [{ type: 'text', text: `❌ every product requires a url (marketplace listing URL, not source article); missing on: ${missingUrl.map(x => x.name).join(', ')}` }], details: { path: '', slug: '' } };
        if (!p.merchants?.length) return { content: [{ type: 'text', text: '❌ merchants array is required (at least 1 merchant)' }], details: { path: '', slug: '' } };

        const html = generateDashboardHtml(p);

        const root = isAbsolute(config.dataRoot) ? config.dataRoot : resolve(PROJECT_ROOT, config.dataRoot);
        const dir = resolve(root, 'drive', p.owner_slug);
        mkdirSync(dir, { recursive: true });
        const filePath = resolve(dir, `${p.slug}.html`);
        writeFileSync(filePath, html, 'utf-8');

        const base = (config.reportsUrl || '').replace(/\/$/, '');
        const viewUrl = base
          ? `${base}/api/files/${p.slug}.html/view?slug=${p.owner_slug}`
          : `(local) ${filePath}`;

        return {
          content: [{ type: 'text', text: `✅ Report generated!\n${p.products.length} products, ${p.merchants.length} merchants, ${p.metrics.length} metrics.\n🌐 View online: ${viewUrl}` }],
          details: { path: filePath, slug: p.slug },
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ ${e instanceof Error ? e.message : String(e)}` }], details: { path: '', slug: '' } };
      }
    },
  };
}

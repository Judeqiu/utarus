/**
 * CsvTable — fetches a CSV asset, parses it, renders as a GFM-style table.
 * Row cap default 200; overflow → "Show all N rows" toggles to a code-block
 * view.
 *
 * Spec: docs/webui-chat-design.md §8.3 (csv row), §8.5.
 */

import { useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { fetchAssetText } from '../../api.js';

interface CsvTableProps {
  url: string;
  filename: string;
}

const DEFAULT_ROW_CAP = 200;

export function CsvTable({ url, filename }: CsvTableProps) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ok'; rows: string[][]; truncated: boolean }
  >({ kind: 'loading' });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchAssetText(url)
      .then((text) => {
        if (cancelled) return;
        const parsed = parseCsv(text);
        const truncated = parsed.length > DEFAULT_ROW_CAP;
        const rows = expanded ? parsed : parsed.slice(0, DEFAULT_ROW_CAP);
        setState({ kind: 'ok', rows, truncated });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [url, expanded]);

  if (state.kind === 'loading') {
    return (
      <div className="my-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Loading {filename}…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="my-3 inline-flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <AlertCircle className="h-4 w-4" />
        Failed to load <strong>{filename}</strong>: {state.message}
      </div>
    );
  }

  const { rows, truncated } = state;
  if (rows.length === 0) {
    return (
      <div className="my-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        {filename} (empty)
      </div>
    );
  }

  const [header, ...body] = rows;

  return (
    <div className="my-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600">
          📊 {filename}
        </span>
        <a
          href={downloadUrl(url)}
          className="text-xs text-blue-600 hover:underline"
        >
          download .csv
        </a>
      </div>
      <div className="overflow-x-auto rounded border border-slate-200">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-slate-100">
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="border-b border-slate-200 px-2 py-1 text-left font-semibold"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="even:bg-slate-50">
                {row.map((cell, c) => (
                  <td key={c} className="border-b border-slate-100 px-2 py-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" /> Show first {DEFAULT_ROW_CAP} rows
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" /> Show all rows
            </>
          )}
        </button>
      )}
    </div>
  );
}

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields with escaped
 * quotes. Good enough for the snapshot files the agent produces today.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function downloadUrl(src: string): string {
  try {
    const u = new URL(src, window.location.origin);
    u.pathname = u.pathname.replace(/\/(raw|view)$/, '');
    return u.pathname + u.search;
  } catch {
    return src;
  }
}

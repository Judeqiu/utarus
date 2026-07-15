/**
 * AssetJson — fetches a JSON asset. If the top-level value is an array of
 * objects, render as a table (same rules as CSV); otherwise, syntax-
 * highlighted code block.
 *
 * Spec: docs/webui-chat-design.md §8.3 (json row).
 */

import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { fetchAssetText } from '../../api.js';

interface AssetJsonProps {
  url: string;
  filename: string;
}

const DEFAULT_ROW_CAP = 200;

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'table'; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
  | { kind: 'code'; text: string };

export function AssetJson({ url, filename }: AssetJsonProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchAssetText(url)
      .then((text) => {
        if (cancelled) return;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch (err) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        const tableShape = asTableRowArray(value);
        if (tableShape) {
          const cols = tableShape.columns;
          const truncated = tableShape.rows.length > DEFAULT_ROW_CAP;
          setState({
            kind: 'table',
            columns: cols,
            rows: tableShape.rows.slice(0, DEFAULT_ROW_CAP),
            truncated,
          });
        } else {
          setState({ kind: 'code', text });
        }
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
  }, [url]);

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
  if (state.kind === 'code') {
    return (
      <div className="my-3">
        <div className="mb-1 text-xs font-medium text-slate-600">
          🔧 {filename}
        </div>
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
          <code>{state.text}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className="my-3">
      <div className="mb-1 text-xs font-medium text-slate-600">
        🔧 {filename}
      </div>
      <div className="overflow-x-auto rounded border border-slate-200">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-slate-100">
            <tr>
              {state.columns.map((c) => (
                <th
                  key={c}
                  className="border-b border-slate-200 px-2 py-1 text-left font-semibold"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row, r) => (
              <tr key={r} className="even:bg-slate-50">
                {state.columns.map((c) => (
                  <td key={c} className="border-b border-slate-100 px-2 py-1">
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.truncated && (
        <span className="mt-1 inline-block text-xs text-slate-500">
          Truncated to first {DEFAULT_ROW_CAP} rows
        </span>
      )}
    </div>
  );
}

function asTableRowArray(
  value: unknown,
): { columns: string[]; rows: Record<string, unknown>[] } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.some((v) => typeof v !== 'object' || v === null || Array.isArray(v))) {
    return null;
  }
  const cols = new Set<string>();
  for (const v of value as Record<string, unknown>[]) {
    for (const k of Object.keys(v)) cols.add(k);
  }
  if (cols.size === 0) return null;
  return {
    columns: [...cols],
    rows: value as Record<string, unknown>[],
  };
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

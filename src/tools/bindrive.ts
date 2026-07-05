/**
 * BinDrive tool — lets the agent interact with the BinDrive file portal.
 *
 * Operations: list, upload, download, delete files in an owner entity's
 * drive folder. The agent must supply both the owner slug and a valid
 * auth token (resolved from the entity's state — e.g. user.auth_token or
 * seller.drive_token depending on the domain).
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { config } from '../config.js';

function ok<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text' as const, text }], details };
}
function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}

function getBaseUrl(): string {
  const port = config.webapp.port;
  return `http://localhost:${port}`;
}

async function apiCall(method: string, path: string, token: string, body?: unknown): Promise<unknown> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = { 'Authorization': `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createBinDriveTools(): AgentTool[] {
  const listFiles: AgentTool = {
    name: 'bindrive_list',
    label: 'BinDrive List Files',
    description: 'List all files in an owner entity\'s BinDrive folder. Returns file names, sizes, and modification dates. Requires owner_slug and the entity\'s auth token.',
    parameters: Type.Object({
      owner_slug: Type.String({ description: 'Owner entity slug (user slug, seller slug, etc.).' }),
      token: Type.String({ description: 'Auth token for the owner entity (from entity state — e.g. user.auth_token).' }),
    }),
    async execute(_id, raw) {
      const { owner_slug, token } = raw as { owner_slug: string; token: string };
      try {
        const result = await apiCall('GET', `/api/files?slug=${encodeURIComponent(owner_slug)}`, token) as { files: Array<{ name: string; size: number; modified: string }> };
        if (result.files.length === 0) {
          return ok(`BinDrive folder for "${owner_slug}" is empty.`, { owner_slug, files: [] });
        }
        const lines = result.files.map((f, i) => `  ${i + 1}. ${f.name} (${(f.size / 1024).toFixed(1)} KB, ${new Date(f.modified).toLocaleDateString()})`);
        return ok(`${result.files.length} file(s) in "${owner_slug}":\n${lines.join('\n')}`, { owner_slug, files: result.files });
      } catch (e) {
        return fail(`❌ ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const uploadFile: AgentTool = {
    name: 'bindrive_upload',
    label: 'BinDrive Upload',
    description: 'Upload a text file to an owner entity\'s BinDrive folder. Use for saving reports, documents, or any content.',
    parameters: Type.Object({
      owner_slug: Type.String({ description: 'Owner entity slug.' }),
      token: Type.String({ description: 'Auth token for the owner entity.' }),
      name: Type.String({ description: 'Filename (e.g. "report.html", "pricing-analysis.md").' }),
      content: Type.String({ description: 'File content (text). For HTML reports, pass the full HTML string.' }),
    }),
    async execute(_id, raw) {
      const { owner_slug, token, name, content } = raw as { owner_slug: string; token: string; name: string; content: string };
      try {
        const result = await apiCall('POST', `/api/files?slug=${encodeURIComponent(owner_slug)}`, token, { name, content }) as { ok: boolean; name: string; size: number };
        return ok(`✅ Uploaded "${result.name}" (${(result.size / 1024).toFixed(1)} KB) to BinDrive/${owner_slug}/`, { owner_slug, name: result.name, size: result.size });
      } catch (e) {
        return fail(`❌ ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const downloadFile: AgentTool = {
    name: 'bindrive_download',
    label: 'BinDrive Download',
    description: 'Download a file from an owner entity\'s BinDrive folder. Returns the file content.',
    parameters: Type.Object({
      owner_slug: Type.String({ description: 'Owner entity slug.' }),
      token: Type.String({ description: 'Auth token for the owner entity.' }),
      name: Type.String({ description: 'Filename to download.' }),
    }),
    async execute(_id, raw) {
      const { owner_slug, token, name } = raw as { owner_slug: string; token: string; name: string };
      try {
        const content = await apiCall('GET', `/api/files/${encodeURIComponent(name)}?slug=${encodeURIComponent(owner_slug)}`, token) as string;
        return ok(`File "${name}" from BinDrive/${owner_slug}/:\n\n${content}`, { owner_slug, name, content });
      } catch (e) {
        return fail(`❌ ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const deleteFile: AgentTool = {
    name: 'bindrive_delete',
    label: 'BinDrive Delete',
    description: 'Delete a file from an owner entity\'s BinDrive folder.',
    parameters: Type.Object({
      owner_slug: Type.String({ description: 'Owner entity slug.' }),
      token: Type.String({ description: 'Auth token for the owner entity.' }),
      name: Type.String({ description: 'Filename to delete.' }),
    }),
    async execute(_id, raw) {
      const { owner_slug, token, name } = raw as { owner_slug: string; token: string; name: string };
      try {
        await apiCall('DELETE', `/api/files/${encodeURIComponent(name)}?slug=${encodeURIComponent(owner_slug)}`, token);
        return ok(`🗑️ Deleted "${name}" from BinDrive/${owner_slug}/`, { owner_slug, name });
      } catch (e) {
        return fail(`❌ ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  return [listFiles, uploadFile, downloadFile, deleteFile];
}

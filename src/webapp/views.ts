/**
 * BinDrive views — login page + drive folder view.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function loginPage(error?: string, returnUrl?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BinDrive</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2.5rem; width: 100%; max-width: 400px; }
    .logo { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
    .logo svg { width: 28px; height: 28px; }
    h1 { font-size: 1.5rem; }
    .subtitle { color: #8b949e; font-size: 0.9rem; margin-bottom: 2rem; }
    label { display: block; font-size: 0.85rem; color: #8b949e; margin-bottom: 0.3rem; }
    input { width: 100%; padding: 0.6rem 0.8rem; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 0.95rem; margin-bottom: 1rem; font-family: monospace; }
    input:focus { outline: none; border-color: #58a6ff; }
    button { width: 100%; padding: 0.7rem; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #2ea043; }
    .error { background: #2d1117; border: 1px solid #f85149; border-radius: 6px; padding: 0.6rem; margin-bottom: 1rem; color: #f85149; font-size: 0.85rem; text-align: center; }
    .hint { color: #8b949e; font-size: 0.8rem; margin-top: 1rem; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      <h1>BinDrive</h1>
    </div>
    <p class="subtitle">Seller file portal</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/login">
      ${returnUrl ? `<input type="hidden" name="return" value="${escapeHtml(returnUrl)}">` : ''}
      <label for="username">Username <span style="color:#8b949e;font-size:0.75rem">( admins only, leave blank for token auth )</span></label>
      <input type="text" id="username" name="username" placeholder="admin username" autocomplete="username">
      <label for="token">Token / Password</label>
      <input type="password" id="token" name="token" placeholder="drive_token or admin password" required autofocus>
      <button type="submit">Open Drive</button>
    </form>
    <p class="hint">Get your token from the bot or your admin.</p>
  </div>
</body>
</html>`;
}

export function drivePage(
  user: { type: string; displayName: string; slug: string },
  targetSlug: string,
  files: Array<{ name: string; size: number; modified: string }>
): string {
  const fileList = files.length > 0
    ? files.map(f => `
      <tr>
        <td class="file-name">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
          ${f.name.endsWith('.html')
            ? `<a href="/api/files/${encodeURIComponent(f.name)}/view?slug=${encodeURIComponent(targetSlug)}" target="_blank">${escapeHtml(f.name)}</a>`
            : escapeHtml(f.name)}
        </td>
        <td class="file-size">${formatBytes(f.size)}</td>
        <td class="file-date">${new Date(f.modified).toLocaleDateString()}</td>
        <td class="file-actions">
          <a href="/api/files/${encodeURIComponent(f.name)}?slug=${encodeURIComponent(targetSlug)}" class="btn-sm">Download</a>
          <button onclick="deleteFile('${escapeHtml(f.name)}')" class="btn-sm btn-danger">Delete</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty">No files yet. Upload something or ask your agent to generate a report.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BinDrive — ${escapeHtml(targetSlug)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; }
    .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 1rem 1.5rem; display: flex; justify-content: space-between; align-items: center; }
    .header .logo { display: flex; align-items: center; gap: 0.5rem; }
    .header .logo svg { width: 22px; height: 22px; }
    .header h1 { font-size: 1.1rem; }
    .header .user-info { color: #8b949e; font-size: 0.85rem; display: flex; align-items: center; gap: 1rem; }
    .header a { color: #f85149; text-decoration: none; font-size: 0.85rem; }
    .header a:hover { text-decoration: underline; }
    .container { max-width: 900px; margin: 1.5rem auto; padding: 0 1.5rem; }
    .folder-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .folder-name { font-size: 1rem; color: #8b949e; }
    .folder-name strong { color: #e6edf3; }
    .toolbar { display: flex; gap: 0.5rem; }
    .btn { padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #30363d; background: #161b22; color: #e6edf3; cursor: pointer; font-size: 0.85rem; }
    .btn:hover { border-color: #58a6ff; }
    .btn-primary { background: #238636; border-color: #238636; color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
    th { text-align: left; padding: 0.7rem 1rem; background: #0d1117; color: #8b949e; font-size: 0.8rem; text-transform: uppercase; border-bottom: 1px solid #30363d; }
    td { padding: 0.6rem 1rem; border-bottom: 1px solid #21262d; font-size: 0.9rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #1c2128; }
    .file-name { display: flex; align-items: center; gap: 0.5rem; }
    .file-name a { color: #58a6ff; text-decoration: none; }
    .file-name a:hover { text-decoration: underline; }
    .file-size, .file-date { color: #8b949e; }
    .file-actions { display: flex; gap: 0.4rem; }
    .btn-sm { padding: 0.25rem 0.6rem; border-radius: 4px; border: 1px solid #30363d; background: #0d1117; color: #8b949e; cursor: pointer; font-size: 0.75rem; text-decoration: none; }
    .btn-sm:hover { border-color: #58a6ff; color: #e6edf3; }
    .btn-danger { border-color: #f8514933; }
    .btn-danger:hover { background: #f8514922; border-color: #f85149; color: #f85149; }
    .empty { text-align: center; color: #8b949e; padding: 3rem !important; }
    #upload-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center; }
    #upload-modal.active { display: flex; }
    .modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.5rem; width: 100%; max-width: 450px; }
    .modal h3 { margin-bottom: 1rem; }
    .modal input[type="file"] { margin-bottom: 1rem; }
    .modal .actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      <h1>BinDrive</h1>
    </div>
    <div class="user-info">
      <span><strong>${escapeHtml(user.displayName)}</strong> / ${escapeHtml(targetSlug)}</span>
      <a href="/logout">Sign out</a>
    </div>
  </div>

  <div class="container">
    <div class="folder-header">
      <span class="folder-name">📁 <strong>${escapeHtml(targetSlug)}</strong> — ${files.length} file${files.length === 1 ? '' : 's'}</span>
      <div class="toolbar">
        <button onclick="document.getElementById('upload-modal').classList.add('active')" class="btn btn-primary">Upload</button>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Size</th>
          <th>Modified</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${fileList}
      </tbody>
    </table>
  </div>

  <div id="upload-modal">
    <div class="modal">
      <h3>Upload file</h3>
      <input type="file" id="file-input">
      <div class="actions">
        <button onclick="document.getElementById('upload-modal').classList.remove('active')" class="btn">Cancel</button>
        <button onclick="uploadFile()" class="btn btn-primary">Upload</button>
      </div>
    </div>
  </div>

  <script>
    const SLUG = '${targetSlug}';

    async function uploadFile() {
      const input = document.getElementById('file-input');
      const file = input.files[0];
      if (!file) return;

      const content = await file.text();
      const res = await fetch('/api/files?slug=' + encodeURIComponent(SLUG), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, content })
      });
      if (res.ok) location.reload();
      else alert('Upload failed: ' + (await res.text()));
    }

    async function deleteFile(name) {
      if (!confirm('Delete ' + name + '?')) return;
      const res = await fetch('/api/files/' + encodeURIComponent(name) + '?slug=' + encodeURIComponent(SLUG), {
        method: 'DELETE'
      });
      if (res.ok) location.reload();
      else alert('Delete failed: ' + (await res.text()));
    }
  </script>
</body>
</html>`;
}

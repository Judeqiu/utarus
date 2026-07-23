const form = document.getElementById('signup-form');
const submitBtn = document.getElementById('submit-btn');
const formError = document.getElementById('form-error');
const agentNameEl = document.getElementById('agent-name');
const taglineEl = document.getElementById('tagline');
const loginLink = document.getElementById('login-link');

/**
 * On land: sign out any existing WebUI session immediately.
 * Clears HTTP cookie (server) and SPA localStorage (utarus_session_user).
 */
async function signOutOnLand() {
  try {
    localStorage.removeItem('utarus_session_user');
  } catch {
    /* private mode */
  }
  try {
    await fetch('/api/onboard/signup-reset', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    /* best-effort */
  }
}

async function loadBranding() {
  try {
    const res = await fetch('/api/onboard/signup-config', { credentials: 'same-origin' });
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.agentName) {
      agentNameEl.textContent = cfg.agentName;
      document.title = `${cfg.agentName} — Sign up`;
    }
    if (cfg.tagline) taglineEl.textContent = cfg.tagline;
    if (!cfg.enabled) {
      form.hidden = true;
      showError('Open signup is not enabled on this agent.');
    }
  } catch {
    /* keep defaults */
  }
}

const boot = Promise.all([signOutOnLand(), loadBranding()]);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  await boot;

  const displayName = form.display_name.value.trim();
  const email = form.email.value.trim();
  const password = form.password.value;
  const confirm = form.password_confirm.value;

  if (!displayName) {
    showError('Display name is required.');
    return;
  }
  if (!email) {
    showError('Email is required.');
    return;
  }
  if (password.length < 8) {
    showError('Password must be at least 8 characters.');
    return;
  }
  if (password !== confirm) {
    showError('Passwords do not match.');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account…';

  let res;
  try {
    res = await fetch('/api/onboard/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        display_name: displayName,
        email,
        password,
      }),
    });
  } catch {
    showError('Network error. Check your connection and try again.');
    resetButton();
    return;
  }

  const body = await res.json().catch(() => ({}));

  if (res.status === 400 || res.status === 409) {
    showError(body.error || 'Invalid input.');
    resetButton();
    return;
  }
  if (res.status === 404) {
    showError(body.message || 'Open signup is not enabled.');
    resetButton();
    return;
  }
  if (!res.ok) {
    showError(body.error || `Server error (${res.status}). Please try again.`);
    resetButton();
    return;
  }

  // Prefer server redirect (usually chat host /login). Fallback: relative login.
  const redirect =
    typeof body.redirect === 'string' && body.redirect
      ? body.redirect
      : `/login?email=${encodeURIComponent(email)}`;
  window.location.href = redirect;
});

function resetButton() {
  submitBtn.disabled = false;
  submitBtn.textContent = 'Create account';
}

function showError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function hideError() {
  formError.hidden = true;
  formError.textContent = '';
}

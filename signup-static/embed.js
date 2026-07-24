/**
 * Utarus open-signup form embed.
 *
 * Mounts into #utarus-signup-root (required). Domain shells own the rest of the page.
 * Loads copy from GET /api/onboard/signup-config. Plain text only (textContent).
 */
(function () {
  'use strict';

  const ROOT_ID = 'utarus-signup-root';

  function referenceFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get('reference') ?? params.get('ref');
      if (raw == null) return undefined;
      const value = raw.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    return node;
  }

  function buildFormTree() {
    const wrap = el('div', 'utarus-signup');
    const card = el('div', 'utarus-signup__card');
    wrap.appendChild(card);

    // Chrome (title / intro / …) — toggled via formChrome
    const chrome = el('div', 'utarus-signup__chrome');
    const header = el('header', 'utarus-signup__header');
    const title = el('h1', 'utarus-signup__title', { id: 'utarus-signup-title', text: 'Agent' });
    const tagline = el('p', 'utarus-signup__tagline', {
      id: 'utarus-signup-tagline',
      text: 'Create an account to chat with your agent.',
    });
    header.appendChild(title);
    header.appendChild(tagline);
    chrome.appendChild(header);

    const notice = el('div', 'utarus-signup__notice', { id: 'utarus-signup-notice', hidden: 'hidden' });
    const intro = el('div', 'utarus-signup__intro', { id: 'utarus-signup-intro', hidden: 'hidden' });
    const bullets = el('ul', 'utarus-signup__bullets', { id: 'utarus-signup-bullets', hidden: 'hidden' });
    chrome.appendChild(notice);
    chrome.appendChild(intro);
    chrome.appendChild(bullets);
    card.appendChild(chrome);

    const form = el('form', 'utarus-signup__form', {
      id: 'utarus-signup-form',
      novalidate: '',
      autocomplete: 'on',
    });

    function field(id, labelText, inputAttrs) {
      const lab = el('label', null, { for: id, text: labelText });
      const input = el('input', null, { id, name: id, ...inputAttrs });
      form.appendChild(lab);
      form.appendChild(input);
      return input;
    }

    field('display_name', 'Display name', {
      type: 'text',
      maxlength: '60',
      required: '',
      placeholder: 'Your name',
      autocomplete: 'name',
      autofocus: '',
    });
    field('email', 'Email', {
      type: 'email',
      maxlength: '254',
      required: '',
      placeholder: 'you@company.com',
      autocomplete: 'email',
      inputmode: 'email',
    });
    field('password', 'Password', {
      type: 'password',
      minlength: '8',
      maxlength: '200',
      required: '',
      placeholder: 'At least 8 characters',
      autocomplete: 'new-password',
    });
    field('password_confirm', 'Confirm password', {
      type: 'password',
      minlength: '8',
      maxlength: '200',
      required: '',
      placeholder: 'Repeat password',
      autocomplete: 'new-password',
    });

    const submit = el('button', 'utarus-signup__submit', {
      type: 'submit',
      id: 'utarus-signup-submit',
      text: 'Create account',
    });
    const error = el('p', 'utarus-signup__error', {
      id: 'utarus-signup-error',
      hidden: 'hidden',
    });
    form.appendChild(submit);
    form.appendChild(error);
    card.appendChild(form);

    const footer = el('footer', 'utarus-signup__footer');
    const loginP = el('p');
    loginP.appendChild(document.createTextNode('Already have an account? '));
    const loginLink = el('a', null, {
      id: 'utarus-signup-login',
      href: '/login',
      text: 'Sign in',
    });
    loginP.appendChild(loginLink);
    const footerNote = el('p', 'utarus-signup__footer-note', {
      id: 'utarus-signup-footer-note',
      hidden: 'hidden',
    });
    footer.appendChild(loginP);
    footer.appendChild(footerNote);
    card.appendChild(footer);

    return {
      wrap,
      chrome,
      title,
      tagline,
      notice,
      intro,
      bullets,
      form,
      submit,
      error,
      loginLink,
      footerNote,
    };
  }

  async function signOutOnLand() {
    try {
      localStorage.removeItem('utarus_session_user');
    } catch {
      /* ignore */
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

  function applyConfig(ui, cfg) {
    const formChrome = cfg.formChrome !== false;

    if (!formChrome) {
      ui.chrome.hidden = true;
    } else {
      ui.chrome.hidden = false;
      const titleText =
        (typeof cfg.title === 'string' && cfg.title.trim()) ||
        (typeof cfg.agentName === 'string' && cfg.agentName.trim()) ||
        'Agent';
      ui.title.textContent = titleText;
      document.title = `${titleText} · Sign up`;

      if (typeof cfg.tagline === 'string' && cfg.tagline.trim()) {
        ui.tagline.textContent = cfg.tagline.trim();
      }

      if (typeof cfg.notice === 'string' && cfg.notice.trim()) {
        ui.notice.textContent = cfg.notice.trim();
        ui.notice.hidden = false;
      }

      if (Array.isArray(cfg.intro) && cfg.intro.length > 0) {
        ui.intro.replaceChildren();
        for (const para of cfg.intro) {
          if (typeof para !== 'string' || !para.trim()) continue;
          const p = document.createElement('p');
          p.textContent = para.trim();
          ui.intro.appendChild(p);
        }
        ui.intro.hidden = ui.intro.childElementCount === 0;
      }

      if (Array.isArray(cfg.bullets) && cfg.bullets.length > 0) {
        ui.bullets.replaceChildren();
        for (const item of cfg.bullets) {
          if (typeof item !== 'string' || !item.trim()) continue;
          const li = document.createElement('li');
          li.textContent = item.trim();
          ui.bullets.appendChild(li);
        }
        ui.bullets.hidden = ui.bullets.childElementCount === 0;
      }
    }

    // document title even without form chrome
    if (!formChrome) {
      const t =
        (typeof cfg.title === 'string' && cfg.title.trim()) ||
        (typeof cfg.agentName === 'string' && cfg.agentName.trim()) ||
        'Sign up';
      document.title = `${t} · Sign up`;
    }

    if (typeof cfg.footerNote === 'string' && cfg.footerNote.trim()) {
      ui.footerNote.textContent = cfg.footerNote.trim();
      ui.footerNote.hidden = false;
    }

    if (typeof cfg.submitLabel === 'string' && cfg.submitLabel.trim()) {
      ui.submit.textContent = cfg.submitLabel.trim();
    }

    if (
      typeof cfg.accentColor === 'string' &&
      /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(cfg.accentColor.trim())
    ) {
      ui.wrap.style.setProperty('--utarus-accent', cfg.accentColor.trim());
    }

    if (cfg.enabled === false) {
      ui.form.hidden = true;
      showError(ui, 'Open signup is not enabled on this agent.');
    }
  }

  function showError(ui, msg) {
    ui.error.textContent = msg;
    ui.error.hidden = false;
  }

  function hideError(ui) {
    ui.error.hidden = true;
    ui.error.textContent = '';
  }

  function resetButton(ui, label) {
    ui.submit.disabled = false;
    ui.submit.textContent = label || 'Create account';
  }

  async function loadConfig() {
    const res = await fetch('/api/onboard/signup-config', {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      throw new Error(`signup-config HTTP ${res.status}`);
    }
    return res.json();
  }

  function wireSubmit(ui, boot) {
    ui.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError(ui);
      await boot;

      const displayName = ui.form.display_name.value.trim();
      const email = ui.form.email.value.trim();
      const password = ui.form.password.value;
      const confirm = ui.form.password_confirm.value;

      if (!displayName) {
        showError(ui, 'Display name is required.');
        return;
      }
      if (!email) {
        showError(ui, 'Email is required.');
        return;
      }
      if (password.length < 8) {
        showError(ui, 'Password must be at least 8 characters.');
        return;
      }
      if (password !== confirm) {
        showError(ui, 'Passwords do not match.');
        return;
      }

      const defaultLabel = ui.submit.textContent || 'Create account';
      ui.submit.disabled = true;
      ui.submit.textContent = 'Creating account…';

      const reference = referenceFromUrl();
      const payload = {
        display_name: displayName,
        email,
        password,
      };
      if (reference) payload.reference = reference;

      let res;
      try {
        res = await fetch('/api/onboard/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        });
      } catch {
        showError(ui, 'Network error. Check your connection and try again.');
        resetButton(ui, defaultLabel);
        return;
      }

      const body = await res.json().catch(() => ({}));

      if (res.status === 400 || res.status === 409) {
        showError(ui, body.error || 'Invalid input.');
        resetButton(ui, defaultLabel);
        return;
      }
      if (res.status === 404) {
        showError(ui, body.message || 'Open signup is not enabled.');
        resetButton(ui, defaultLabel);
        return;
      }
      if (!res.ok) {
        showError(ui, body.error || `Server error (${res.status}). Please try again.`);
        resetButton(ui, defaultLabel);
        return;
      }

      const redirect =
        typeof body.redirect === 'string' && body.redirect
          ? body.redirect
          : `/login?email=${encodeURIComponent(email)}`;
      window.location.href = redirect;
    });
  }

  function mount() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      console.error(
        `[utarus signup] Missing #${ROOT_ID}. Domain shells must include ` +
          `<div id="${ROOT_ID}"></div> and load /signup/embed.js.`,
      );
      return;
    }

    const ui = buildFormTree();
    root.replaceChildren(ui.wrap);
    ui.loginLink.href = '/login';

    const boot = Promise.all([
      signOutOnLand(),
      loadConfig()
        .then((cfg) => applyConfig(ui, cfg))
        .catch((err) => {
          console.error('[utarus signup] config load failed', err);
        }),
    ]);

    wireSubmit(ui, boot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();

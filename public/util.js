// Small DOM/API helpers shared by app.js and the feature modules.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
export const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

export async function api(method, url, body, init = {}) {
  const opts = { method, ...init };
  if (body instanceof Blob) opts.body = body;
  else if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
  if (!r.ok || data?.error) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

export function toast(text, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t-bar"></span><span>${esc(text)}</span>`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? ms * 2 : ms);
}

// Modal dialog with arbitrary buttons. Resolves to the clicked button's value (or null on dismiss).
let modalResolve = null;
export function openModal(html, { focus } = {}) {
  $('#modal').innerHTML = html;
  $('#modalWrap').hidden = false;
  if (focus) $(focus, $('#modal'))?.focus();
}
export function closeModal(result = null) {
  $('#modalWrap').hidden = true;
  if (modalResolve) {
    const r = modalResolve;
    modalResolve = null;
    r(result);
  }
}
export function choiceModal(title, text, buttons, extraHtml = '') {
  openModal(`<h3>${esc(title)}</h3><p>${text}</p>${extraHtml}<div class="foot">${buttons.map((b, i) =>
    `<button class="btn ${b.kind || ''}" data-choice="${i}">${b.icon ? icon(b.icon) : ''}${esc(b.label)}</button>`).join('')}</div>`);
  const primary = buttons.findIndex((b) => b.primary);
  $(`[data-choice="${primary >= 0 ? primary : buttons.length - 1}"]`, $('#modal'))?.focus();
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('#modal').onclick = (e) => {
      const b = e.target.closest('[data-choice]');
      if (b) closeModal(buttons[+b.dataset.choice].value);
    };
  });
}
export function confirmModal(title, text, okLabel = 'OK', danger = false) {
  return choiceModal(title, esc(text), [
    { label: 'Cancel', kind: 'ghost', value: false },
    { label: okLabel, kind: danger ? 'danger' : 'accent', value: true, primary: true },
  ]).then((v) => v === true);
}

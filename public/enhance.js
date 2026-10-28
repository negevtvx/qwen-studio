// Prompt enhancer: rewrites the prompt with a local Ollama model using the official Qwen Image 2.1
// instructions, streams it into a review card, and never replaces your text without a click.
import { $, esc, icon, api, toast } from '/util.js';

let ctx;
let catalog = null; // last /api/ollama/models answer
const runs = { create: null, edit: null };

export function init(c) {
  ctx = c;
  document.addEventListener('click', onClick);
}

const card = (kind) => $(`.enhance-card[data-for="${kind}"]`);

async function loadCatalog(force = false) {
  if (catalog && !force) return catalog;
  try { catalog = await api('GET', '/api/ollama/models'); } catch { catalog = { online: false, models: [] }; }
  return catalog;
}

export async function start(kind) {
  const text = ctx.getText(kind).trim();
  if (!text) return toast(kind === 'edit' ? 'Write an instruction first' : 'Write a prompt first');
  if (kind === 'edit' && !ctx.state.refs.length) return toast('Add the image to edit first');
  runs[kind]?.ac?.abort();
  const run = { ac: new AbortController(), original: text, text: '', status: 'streaming', model: null };
  runs[kind] = run;
  render(kind);
  try {
    const body = { kind, text, model: ctx.state.ui.enhanceModel || undefined };
    if (kind === 'edit') body.images = await ctx.refImages(4);
    const res = await fetch('/api/enhance', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: run.ac.signal,
    });
    if (!(res.headers.get('content-type') || '').includes('ndjson')) {
      const j = await res.json().catch(() => ({}));
      run.status = j.offline ? 'offline' : 'error';
      run.error = j.error || `HTTP ${res.status}`;
      if (run.status === 'offline') await loadCatalog(true);
      return render(kind);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.delta) {
          run.text += m.delta;
          const out = $('.ec-text', card(kind));
          if (out) { out.value = run.text; out.scrollTop = out.scrollHeight; }
        } else if (m.done) Object.assign(run, { status: 'ready', text: m.text, model: m.model, ms: m.ms, unloaded: m.unloaded });
        else if (m.error) Object.assign(run, { status: 'error', error: m.error });
      }
    }
    if (run.status === 'streaming') Object.assign(run, run.text ? { status: 'ready' } : { status: 'error', error: 'No answer from the model' });
  } catch (e) {
    Object.assign(run, e.name === 'AbortError' ? { status: 'stopped' } : { status: 'error', error: e.message });
  }
  if (runs[kind] === run) render(kind);
  return undefined;
}

function modelSelect(kind) {
  if (!catalog?.models?.length) return '';
  const needVision = kind === 'edit';
  const current = runs[kind]?.model || ctx.state.ui.enhanceModel || catalog.chosen?.[kind] || '';
  const opts = catalog.models.map((m) => {
    const off = needVision && !m.vision;
    const tags = [m.params, m.vision ? 'vision' : '', catalog.loaded?.includes(m.name) ? 'loaded' : ''].filter(Boolean).join(' · ');
    return `<option value="${esc(m.name)}" ${m.name === current ? 'selected' : ''} ${off ? 'disabled' : ''}>${esc(m.name)}${tags ? ` (${esc(tags)})` : ''}</option>`;
  }).join('');
  return `<select class="ec-model" title="Ollama model used for enhancing">${opts}</select>`;
}

function render(kind) {
  const el = card(kind);
  if (!el) return;
  const run = runs[kind];
  el.hidden = !run;
  if (!run) return;
  el.dataset.status = run.status;
  const keep = ctx.state.ui.enhanceKeepLoaded;
  if (run.status === 'streaming') {
    el.innerHTML = `<div class="ec-head">${icon('spark')}<span class="ec-title">Enhancing with ${esc(run.model || ctx.state.ui.enhanceModel || 'Ollama')}…</span>
        <button class="btn btn-xs ghost" data-ec="stop">${icon('stop')}Stop</button></div>
      <textarea class="ec-text streaming" readonly placeholder="Loading the model can take a few seconds…"></textarea>`;
  } else if (run.status === 'ready') {
    const meta = [run.model, run.ms ? `${(run.ms / 1000).toFixed(1)} s` : '', run.unloaded ? 'unloaded after use' : ''].filter(Boolean).join(' · ');
    el.innerHTML = `<div class="ec-head">${icon('spark')}<span class="ec-title">Enhanced prompt</span></div>
      <div class="ec-sub">${esc(meta)} — edit it freely before using it</div>
      <textarea class="ec-text" spellcheck="true"></textarea>
      <div class="ec-foot">
        <button class="btn btn-sm accent" data-ec="use">${icon('spark')}Use this</button>
        <button class="btn btn-sm ghost" data-ec="retry">${icon('reuse')}Retry</button>
        <button class="btn btn-sm ghost" data-ec="discard">Discard</button>
      </div>
      <div class="ec-opts">${modelSelect(kind)}
        <label class="switch xs"><input type="checkbox" data-ec="keep" ${keep ? 'checked' : ''}><span class="track"></span><span>Keep loaded</span></label></div>`;
  } else if (run.status === 'offline') {
    el.innerHTML = `<div class="ec-head">${icon('spark')}<span class="ec-title">Ollama isn't running</span></div>
      <p class="ec-msg">The enhancer uses a local model through Ollama, with the official Qwen Image 2.1 rewriting instructions.</p>
      <div class="ec-foot">${catalog?.canStart ? `<button class="btn btn-sm accent" data-ec="start-ollama">${icon('play')}Start Ollama</button>` : '<span class="ec-msg">Install Ollama from ollama.com, then try again.</span>'}
        <button class="btn btn-sm ghost" data-ec="discard">Dismiss</button></div>`;
  } else if (run.status === 'applied') {
    el.innerHTML = `<div class="ec-applied">${icon('spark')}<span>Prompt enhanced${run.model ? ` with ${esc(run.model)}` : ''}.</span>
      <button class="linkish" data-ec="undo">Undo</button><button class="icon-btn sm" data-ec="discard" title="Dismiss">${icon('x')}</button></div>`;
  } else {
    el.innerHTML = `<div class="ec-head">${icon('spark')}<span class="ec-title">${run.status === 'stopped' ? 'Stopped' : 'Could not enhance'}</span></div>
      ${run.error ? `<p class="ec-msg">${esc(run.error)}</p>` : ''}
      <div class="ec-foot"><button class="btn btn-sm ghost" data-ec="retry">${icon('reuse')}Try again</button>
        <button class="btn btn-sm ghost" data-ec="discard">Dismiss</button><span class="topbar-spacer"></span>${modelSelect(kind)}</div>`;
  }
  const ta = $('.ec-text', el);
  if (ta) ta.value = run.text;
  if (run.status !== 'streaming' && run.status !== 'applied' && !catalog) loadCatalog().then(() => runs[kind] === run && render(kind));
}

async function onClick(e) {
  const trigger = e.target.closest('[data-enhance]');
  if (trigger) return start(trigger.dataset.enhance);
  const b = e.target.closest('[data-ec]');
  if (!b || b.tagName === 'INPUT') return undefined;
  const el = b.closest('.enhance-card');
  const kind = el.dataset.for;
  const run = runs[kind];
  switch (b.dataset.ec) {
    case 'stop': run?.ac.abort(); break;
    case 'retry': start(kind); break;
    case 'discard': runs[kind] = null; render(kind); break;
    case 'use': {
      const text = $('.ec-text', el).value.trim();
      if (!text) break;
      ctx.setText(kind, text);
      runs[kind] = { status: 'applied', original: run.original, model: run.model };
      render(kind);
      break;
    }
    case 'undo':
      ctx.setText(kind, run.original);
      runs[kind] = null;
      render(kind);
      toast('Restored your original prompt', 'ok', 1800);
      break;
    case 'start-ollama':
      b.disabled = true;
      b.textContent = 'Starting…';
      try {
        await api('POST', '/api/ollama/start');
        await loadCatalog(true);
        start(kind);
      } catch (err) {
        toast(err.message, 'error');
        b.disabled = false;
      }
      break;
    default: break;
  }
  return undefined;
}

document.addEventListener('change', (e) => {
  if (e.target.matches('.ec-model')) {
    ctx.setUi({ enhanceModel: e.target.value });
    start(e.target.closest('.enhance-card').dataset.for);
  } else if (e.target.matches('[data-ec="keep"]')) {
    ctx.setUi({ enhanceKeepLoaded: e.target.checked });
  }
});

// Called when the user types in the prompt box: an old suggestion no longer matches, so fold it away.
export function onPromptEdited(kind) {
  if (runs[kind]?.status === 'applied') {
    runs[kind] = null;
    render(kind);
  }
}

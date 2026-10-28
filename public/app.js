import {
  ASPECTS, MEGAPIXELS, PRESET_ORDER, presetsFor, resolvedSize, matchPreset, estimateSeconds,
  formatDuration, snap, itsFor,
} from '/shared.mjs';
import { $, $$, esc, icon, gb, api, toast, closeModal, confirmModal } from '/util.js';
import * as enhance from '/enhance.js';
import * as compare from '/compare.js';
import * as guard from '/vramguard.js';

const FINAL = new Set(['done', 'error', 'cancelled']);
const FALLBACK_SAMPLERS = ['euler', 'res_multistep', 'dpmpp_2m', 'uni_pc', 'euler_ancestral', 'dpmpp_2m_sde', 'heun', 'deis', 'ddim', 'lcm'];
const FALLBACK_SCHEDULERS = ['simple', 'normal', 'karras', 'exponential', 'sgm_uniform', 'beta', 'linear_quadratic', 'kl_optimal', 'ddim_uniform'];
const EDIT_RES = [{ v: 1024, label: '1024', sub: 'official' }, { v: 1536, label: '1536' }, { v: 2048, label: '2048', sub: '2K' }, { v: 0, label: 'Original' }];
const QUICK_EDITS = [
  { icon: 'scissors', label: 'Remove background', prompt: 'Remove the background, and output a PNG image', transparent: true },
  { icon: 'image', label: 'Restore photo', prompt: 'Restore this photo: remove noise, scratches and blur, sharpen fine details and keep the people, composition and colors exactly the same' },
  { icon: 'spark', label: 'Golden hour', prompt: 'Change the lighting to warm golden-hour sunlight with long soft shadows, keep everything else the same' },
  { icon: 'layers', label: 'Outfit from <image2>', prompt: 'Replace the clothing of the person in <image1> with the outfit from <image2>, keep the face, pose and background unchanged' },
  { icon: 'wand', label: 'Watercolor', prompt: 'Turn this into a loose watercolor painting on textured cold-press paper' },
];

// ---------- state ----------
const state = {
  gen: null, ui: null, defaults: null, app: null,
  status: { state: 'offline' }, info: null,
  jobs: new Map(),
  gallery: [], session: [],
  selectedId: null,
  view: 'item',
  liveId: null,
  logs: [], logIndex: new Map(), logErrors: 0,
  system: null,
  history: [],
  refs: [],
  lastSeed: null,
  submitting: false,
  galleryTotal: 0,
  booted: false,
};

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const gen = { ...state.gen };
    if (state.ui.incognito) { delete gen.prompt; delete gen.negative; delete gen.editPrompt; }
    api('PUT', '/api/settings', { gen, ui: state.ui }).catch(() => {});
  }, 400);
}
function setGen(patch) {
  Object.assign(state.gen, patch);
  renderDerived();
  saveSoon();
}
function setUi(patch) {
  Object.assign(state.ui, patch);
  saveSoon();
}

const allItems = () => [...state.session, ...state.gallery];
const findItem = (id) => allItems().find((i) => i.id === id) || null;
const activeJobs = () => [...state.jobs.values()].filter((j) => !FINAL.has(j.status)).sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : a.queuedAt - b.queuedAt));

// ---------- events from the server ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => boot(JSON.parse(e.data)));
  es.addEventListener('status', (e) => { state.status = JSON.parse(e.data); renderStatus(); });
  es.addEventListener('logs', (e) => addLogs(JSON.parse(e.data)));
  es.addEventListener('job', (e) => onJob(JSON.parse(e.data)));
  es.addEventListener('progress', (e) => onProgress(JSON.parse(e.data)));
  es.addEventListener('preview', (e) => onPreview(JSON.parse(e.data)));
  es.addEventListener('image', (e) => onImage(JSON.parse(e.data)));
  es.addEventListener('info', (e) => { state.info = JSON.parse(e.data); fillSelects(); });
  es.addEventListener('system', (e) => { state.system = JSON.parse(e.data); renderSystem(); });
  es.addEventListener('toast', (e) => { const t = JSON.parse(e.data); toast(t.text, t.kind); });
  es.addEventListener('calib', (e) => onCalib(JSON.parse(e.data)));
  es.addEventListener('bye', () => showClosed());
  es.onerror = () => { if (state.booted) { state.status = { state: 'offline', disconnected: true }; renderStatus(); } };
}

async function boot(snap) {
  const first = !state.booted;
  state.booted = true;
  state.gen = snap.settings.gen;
  state.ui = snap.settings.ui;
  state.defaults = snap.defaults;
  state.app = snap.app;
  state.status = snap.status;
  state.info = snap.info;
  state.session = snap.session || [];
  state.jobs = new Map(snap.jobs.map((j) => [j.id, j]));
  state.logs = [];
  state.logIndex.clear();
  $('#logsScroll').replaceChildren();
  addLogs(snap.logs, true);
  if (first && new URLSearchParams(location.search).get('incognito') === '1' && !state.ui.incognito) {
    state.ui.incognito = true;
    saveSoon();
  }
  if (first) bindUi();
  fillSelects();
  syncForm();
  renderStatus();
  renderQueue();
  renderIncognito();
  renderLogsOpen();
  await loadGallery();
  loadHistory();
  const running = activeJobs().find((j) => j.status === 'running');
  if (running) { state.view = 'live'; state.liveId = running.id; }
  renderStage();
}

// The gallery is paged from the server (newest first); search and the starred filter run server-side.
const PAGE = 150;
const galleryQuery = () => ({
  starred: state.ui.galleryFilter === 'starred' ? '1' : '0',
  q: ($('#gallerySearch').value || '').trim(),
});
async function loadGallery() {
  const q = galleryQuery();
  const key = JSON.stringify(q);
  state.galleryKey = key;
  const r = await api('GET', `/api/gallery?limit=${PAGE}&starred=${q.starred}&q=${encodeURIComponent(q.q)}`);
  if (state.galleryKey !== key) return; // a newer search won
  state.gallery = r.items;
  state.galleryTotal = r.total;
  if (!state.selectedId && allItems()[0]) state.selectedId = allItems()[0].id;
  renderGallery();
}
async function loadMore() {
  if (state.loadingMore || state.gallery.length >= state.galleryTotal) return false;
  state.loadingMore = true;
  try {
    const q = galleryQuery();
    const r = await api('GET', `/api/gallery?offset=${state.gallery.length}&limit=${PAGE}&starred=${q.starred}&q=${encodeURIComponent(q.q)}`);
    const have = new Set(state.gallery.map((i) => i.id));
    state.gallery.push(...r.items.filter((i) => !have.has(i.id)));
    state.galleryTotal = r.total;
    renderGallery();
    return r.items.length > 0;
  } finally {
    state.loadingMore = false;
  }
}
const matchesSearch = (it, q) => !q || `${it.prompt || ''} ${it.editPrompt || ''} ${it.seed}`.toLowerCase().includes(q.toLowerCase());
async function loadHistory() {
  try { state.history = await api('GET', '/api/history'); } catch { state.history = []; }
  renderFavButton();
}

function onJob(j) {
  const prev = state.jobs.get(j.id);
  state.jobs.set(j.id, { ...prev, ...j });
  if (j.status === 'running' && prev?.status !== 'running') {
    compare.close();
    state.view = 'live';
    state.liveId = j.id;
    state.progress = null;
    state.preview = null;
    renderStage();
  }
  if (FINAL.has(j.status) && !FINAL.has(prev?.status)) {
    if (j.status === 'done' && document.hidden) state.finishedWhileHidden = true;
    setTimeout(refreshTitle, 0);
    if (j.status === 'error') toast(j.error || 'Generation failed — see the log panel', 'error');
    if (j.status === 'cancelled') toast(j.error?.startsWith('Cancelled') ? j.error : 'Cancelled');
    // Done jobs hand over to the image event; this is only the fallback if no image shows up.
    const leave = () => {
      if (state.liveId !== j.id) return;
      state.view = 'item';
      state.liveId = null;
      renderStage();
    };
    if (j.status === 'done') setTimeout(leave, 2500);
    else leave();
  }
  if (state.liveId === j.id) renderLive();
  renderQueue();
  renderGenerateButton();
}

function onProgress(p) {
  const j = state.jobs.get(p.id);
  if (j && p.node === '7') Object.assign(j, { step: p.value, steps: p.max, itps: p.itps });
  if (p.id === state.liveId) renderLive(p);
}

function onPreview(p) {
  if (p.id !== state.liveId || state.view !== 'live') return;
  const img = $('#previewImg');
  img.src = p.src;
  img.classList.remove('placeholder');
}

// Qwen's cutout returns an all-transparent image when it finds no clear foreground (e.g. a landscape).
async function warnIfEmptyCutout(item) {
  try {
    const img = new Image();
    img.src = item.url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 48, 48);
    const d = ctx.getImageData(0, 0, 48, 48).data;
    let opaque = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) opaque++;
    if (opaque / (48 * 48) < 0.01) {
      toast('The cutout came back empty — Qwen found no distinct foreground subject to keep. Background removal works best on a clear subject (person, product, animal, object), not on full scenes.', 'error', 7000);
    }
  } catch { /* best effort */ }
}

function onImage(item) {
  if (item.hasAlpha && item.kind === 'edit') warnIfEmptyCutout(item);
  if (item.incognito) state.session.unshift(item);
  else if (state.ui.galleryFilter !== 'starred' && matchesSearch(item, galleryQuery().q)) {
    state.gallery.unshift(item);
    state.galleryTotal++;
  }
  compare.close();
  state.selectedId = item.id;
  state.view = 'item';
  if (state.liveId === item.jobId) state.liveId = null;
  state.newId = item.id;
  const j = state.jobs.get(item.jobId);
  if (j && !j.startedAt) j.startedAt = Date.now();
  renderGallery();
  renderStage();
}

function onCalib({ key, itps }) {
  if (typeof key !== 'string' || typeof itps !== 'number' || !(itps > 0)) return;
  const old = state.ui.calib?.[key];
  const next = typeof old === 'number' ? old * 0.5 + itps * 0.5 : itps;
  setUi({ calib: { ...state.ui.calib, [key]: +next.toFixed(3) } });
  renderDerived();
}

// ---------- form ----------
function syncForm() {
  const g = state.gen;
  $('#app').dataset.tab = state.ui.tab;
  $('#prompt').value = g.prompt;
  $('#editPrompt').value = g.editPrompt;
  $('#negative').value = g.negative;
  $('#transparent').checked = !!g.transparent;
  $('#editTransparent').checked = !!g.editTransparent;
  $('#width').value = g.width;
  $('#height').value = g.height;
  $('#customToggle').checked = !!g.customSize;
  $('#batch').value = g.batch;
  $('#steps').value = Math.min(80, g.steps);
  $('#stepsNum').value = g.steps;
  $('#cfg').value = Math.max(1, Math.min(8, g.cfg));
  $('#cfgNum').value = g.cfg;
  $('#sampler').value = g.sampler;
  $('#scheduler').value = g.scheduler;
  $('#cacheDevice').value = g.cacheDevice;
  $('#cacheDtype').value = g.cacheDtype;
  $('#advanced').open = !!state.ui.advancedOpen;
  $('#negGroup').hidden = !state.ui.negativeOpen;
  renderDerived();
}

function fillSelects() {
  const fill = (sel, list, value) => {
    sel.innerHTML = list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.value = value;
  };
  fill($('#sampler'), state.info?.samplers || FALLBACK_SAMPLERS, state.gen.sampler);
  fill($('#scheduler'), state.info?.schedulers || FALLBACK_SCHEDULERS, state.gen.scheduler);
  const hasUnet = (f) => !state.info?.unets || state.info.unets.includes(f);
  const hasClip = (f) => !state.info?.clips?.length || state.info.clips.includes(f);
  for (const b of $$('#modelSeg button')) {
    const p = state.app.profiles?.[b.dataset.model];
    const listed = !state.info?.unets || (hasUnet(p?.unet) && hasClip(p?.clip));
    const ggufOk = !p?.unet?.toLowerCase().endsWith('.gguf') || state.info?.gguf !== false;
    const ok = !!p && p.ready !== false && listed && ggufOk;
    b.disabled = !ok;
    b.title = !p ? '' : p.ready === false ? `Not downloaded — run Install.bat and choose ${p.label}` : !listed ? 'Restart ComfyUI so it sees this model' : !ggufOk ? 'Restart ComfyUI so the GGUF loaders are available' : `${p.unet}`;
  }
}

function currentEstimate() {
  const g = state.gen;
  const calib = state.ui.calib;
  if (state.ui.tab === 'edit') {
    const target = state.refs[0];
    let mp = 1;
    if (g.editResolution > 0) mp = (g.editResolution / 1024) ** 2;
    else if (target) mp = (target.w * target.h) / 1024 ** 2;
    const refs = Math.max(1, state.refs.length);
    return (g.steps / itsFor(g.model, mp, calib)) * (1 + 0.25 * refs) + 1.5;
  }
  return estimateSeconds(g, calib);
}

function renderDerived() {
  const g = state.gen;
  const { width, height } = resolvedSize(g);
  const mp = (width * height) / 1024 ** 2;

  // presets
  const current = matchPreset(g, { ignoreSize: state.ui.tab === 'edit' });
  const presets = presetsFor(g.model);
  $('#presets').innerHTML = PRESET_ORDER.map((k, i) => {
    const p = presets[k];
    const est = state.ui.tab === 'edit' ? null : estimateSeconds({ ...g, ...p, customSize: false }, state.ui.calib);
    return `<button class="preset ${current === k ? 'on' : ''}" data-preset="${k}" title="${esc(`${p.model} · ${p.megapixels} MP · ${p.steps} steps · ${p.sampler}  (key ${i + 1})`)}">
      <b>${p.label}</b><small>${esc(p.blurb)}</small><span class="eta">${est ? '≈ ' + formatDuration(est) : `${p.steps} steps`}</span></button>`;
  }).join('') + (current === 'custom' ? '<div class="preset-custom">Custom settings — pick a preset to reset size, model, steps and sampler.</div>' : '');

  // size
  $('#aspects').innerHTML = ASPECTS.map((a) => {
    const s = 15 / Math.max(a.w, a.h);
    return `<button class="aspect ${!g.customSize && g.aspect === a.id ? 'on' : ''}" data-aspect="${a.id}" title="${a.id}">
      <i style="width:${Math.max(5, a.w * s)}px;height:${Math.max(5, a.h * s)}px"></i>${a.id}</button>`;
  }).join('');
  $('#mpSeg').innerHTML = MEGAPIXELS.map((m) => `<button class="${!g.customSize && g.megapixels === m.mp ? 'on' : ''}" data-mp="${m.mp}">${m.label}<small style="opacity:.6;font-weight:500">${m.mp === 4 ? '' : ' MP'}</small></button>`).join('');
  $('#mpSeg').hidden = !!g.customSize;
  $('#customSize').hidden = !g.customSize;
  $('#sizeHint').textContent = `${width} × ${height} · ${mp.toFixed(2)} MP`;
  if (!g.customSize) { $('#width').value = width; $('#height').value = height; }

  // edit resolution
  $('#editResSeg').innerHTML = EDIT_RES.map((r) => `<button class="${g.editResolution === r.v ? 'on' : ''}" data-res="${r.v}">${r.label}${r.sub ? `<small style="opacity:.55;font-weight:500"> ${r.sub}</small>` : ''}</button>`).join('');

  // model
  for (const b of $$('#modelSeg button')) b.classList.toggle('on', b.dataset.model === g.model);
  const prof = state.app.profiles?.[g.model];
  const over = prof && mp > (prof.maxMp || 4) + 0.05;
  const vramWarn = over || ((mp > (prof?.maxMp || 4)) && (state.system?.ollama?.models?.length || 0) > 0);
  const offSchedule = g.steps !== 8 || g.sampler !== 'euler';
  $('#modelHint').textContent = prof?.ready === false
    ? `Run Install.bat and choose ${prof.label}`
    : vramWarn
      ? `${prof?.label || 'This pack'} is happiest at ${prof?.maxMp || ''} MP and under`
      : offSchedule
        ? 'Distilled schedule is 8 Euler steps at CFG 1'
        : (prof?.blurb || '8-step Turbo schedule');
  $('#modelHint').style.color = (prof?.ready === false || vramWarn) ? 'var(--warn)' : '';

  // seed
  const seedInput = $('#seed');
  if (document.activeElement !== seedInput) seedInput.value = g.seedLocked ? g.seed : '';
  seedInput.placeholder = g.seedLocked ? '' : 'random each run';
  $('#seedLock').classList.toggle('on', !!g.seedLocked);
  $('#seedLock').innerHTML = icon(g.seedLocked ? 'lock' : 'unlock');
  $('#seedLock').title = g.seedLocked ? 'Seed locked (batches use seed, seed+1, …) — click to randomize each run' : 'Lock seed';
  $('#seedLast').innerHTML = state.lastSeed != null && !g.seedLocked ? `Last: <button id="lockLast" class="mono">${state.lastSeed}</button>` : g.seedLocked && g.batch > 1 ? `Batch uses ${g.seed} … ${g.seed + g.batch - 1}` : '';
  if (document.activeElement !== $('#batch')) $('#batch').value = g.batch;

  // sliders
  for (const [id, min, max] of [['steps', 1, 80], ['cfg', 1, 8]]) {
    const el = $('#' + id);
    el.style.setProperty('--fill', `${((el.value - min) / (max - min)) * 100}%`);
  }
  $('#refCount').textContent = state.refs.length ? `${state.refs.length}/10 · image 1 is edited` : 'image 1 is edited · up to 10';

  renderGenerateButton();
  renderFavButton();
}

function renderGenerateButton() {
  if (!state.gen) return;
  const g = state.gen;
  const edit = state.ui.tab === 'edit';
  const active = activeJobs();
  const off = state.status.state === 'offline';
  let label = edit ? 'Apply edit' : g.batch > 1 ? `Generate ${g.batch}` : 'Generate';
  if (active.length) label = edit ? 'Queue edit' : g.batch > 1 ? `Queue ${g.batch} more` : 'Add to queue';
  if (off) label = edit ? 'Start & edit' : 'Start & generate';
  if (state.submitting) label = state.status.state === 'starting' || off ? 'Starting ComfyUI…' : 'Queuing…';
  $('#generateLabel').textContent = label;
  $('#generateBtn').classList.toggle('working', state.submitting);
  $('#generateBtn').disabled = state.submitting || state.status.state === 'stopping' || (edit && !state.refs.length);
  $('#cancelBtn').hidden = !active.length;

  const est = currentEstimate();
  const count = edit ? g.batch : g.batch;
  const { width, height } = resolvedSize(g);
  const sizeText = edit ? (state.refs[0] ? `from ${state.refs[0].w}×${state.refs[0].h}` : 'add an image') : `${width}×${height}`;
  $('#genMeta').innerHTML = `<span>≈ <b>${formatDuration(est * count)}</b>${count > 1 ? ` for ${count}` : ''}</span><span>${sizeText} · ${g.model} · ${g.steps} steps</span>`;
}

function renderFavButton() {
  const p = (state.gen?.prompt || '').trim();
  const fav = !!state.history.find((h) => h.prompt === p && h.fav);
  $('#favPromptBtn').classList.toggle('on', fav);
  $('#favPromptBtn').title = fav ? 'Remove from favorites' : 'Add prompt to favorites';
}

// ---------- status / comfy ----------
const STATE_LABEL = { offline: 'Offline', starting: 'Starting…', ready: 'Ready', busy: 'Busy', stopping: 'Stopping…' };
function renderStatus() {
  const s = state.status;
  const st = s.disconnected ? 'offline' : s.state;
  $('#statusPill').dataset.state = st;
  $('#statusLabel').textContent = s.disconnected ? 'App offline' : STATE_LABEL[st] || st;
  let sub = '';
  if (st === 'busy') sub = s.queueRemaining > 1 ? `${s.queueRemaining} in queue` : 'generating';
  else if (st === 'ready') sub = s.owned ? '' : 'external';
  else if (st === 'starting' && s.startedAt) sub = 'loading';
  $('#statusSub').textContent = sub;

  const btn = $('#comfyBtn');
  btn.disabled = st === 'stopping' || s.disconnected;
  btn.className = `btn btn-sm ${st === 'offline' ? 'go' : 'stop'}`;
  btn.innerHTML = st === 'offline'
    ? `${icon('play')}<span>Start ComfyUI</span>`
    : st === 'stopping' ? `${icon('stop')}<span>Stopping…</span>` : `${icon('stop')}<span>${st === 'starting' ? 'Cancel start' : 'Kill ComfyUI'}</span>`;
  btn.title = st === 'offline' ? `Launch ComfyUI with ${state.app?.comfyRoot ? 'its run_nvidia_gpu.bat' : 'its launch script'}` : s.owned ? `Stop the ComfyUI process Qwen Studio started (PID ${s.pid})` : 'Stop whatever is listening on the ComfyUI port (asks first)';
  $('#freeBtn').disabled = !['ready', 'busy'].includes(st);
  renderGenerateButton();
  if (!state.selectedId || state.view !== 'item') renderStage();
  else renderEmpty();
  if ($('#drawer').classList.contains('open')) renderSystem();
}

async function toggleComfy() {
  const st = state.status.state;
  try {
    if (st === 'offline') {
      await api('POST', '/api/comfy/start');
      return;
    }
    if (state.status.owned) {
      if (activeJobs().length && !(await confirmModal('Stop ComfyUI?', 'A generation is still running or queued. Stopping ComfyUI cancels it.', 'Kill ComfyUI', true))) return;
      await api('POST', '/api/comfy/stop', {});
      return;
    }
    const owner = await api('GET', '/api/comfy/owner');
    if (!owner) return;
    const name = owner.process?.name || 'unknown process';
    if (!(await confirmModal('Stop external ComfyUI?', `ComfyUI on this port wasn't started by Qwen Studio. Kill PID ${owner.pid} (${name}) and its child processes? Nothing else is touched.`, `Kill PID ${owner.pid}`, true))) return;
    await api('POST', '/api/comfy/stop', { confirmPid: owner.pid });
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- generate ----------
async function generate(kindOverride, extra = {}) {
  if (state.submitting) return;
  const kind = kindOverride || state.ui.tab;
  const body = { kind, incognito: !!state.ui.incognito, settings: { ...state.gen, ...(extra.settings || {}) } };
  if (kind === 'edit') body.refs = extra.refs || state.refs.map((r) => r.ref);
  if (kind === 'upscale' || kind === 'vary') Object.assign(body, { source: extra.source, upscale: extra.upscale, vary: extra.vary });
  if (kind === 'create' && !body.settings.prompt.trim()) { $('#prompt').focus(); toast('Write a prompt first'); return; }
  if (kind === 'edit' && !body.settings.editPrompt.trim()) { $('#editPrompt').focus(); toast('Describe the edit first'); return; }
  state.submitting = true;
  renderGenerateButton();
  try {
    if (!(await guard.ensureRoom({ state, setUi }, runNeedGb(kind, body, extra)))) return;
    const r = await api('POST', '/api/generate', body);
    // Live events can beat this response (ComfyUI starts instantly when idle); never overwrite them.
    for (const j of r.jobs) if (!state.jobs.has(j.id)) state.jobs.set(j.id, j);
    if (kind === 'create' || kind === 'edit') state.lastSeed = r.seed;
    if ((kind === 'create' || kind === 'edit') && !state.ui.incognito) loadHistory();
    renderQueue();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.submitting = false;
    renderDerived();
  }
}

// Peak GPU memory a run will want, for the VRAM guard.
function runNeedGb(kind, body, extra) {
  const g = body.settings;
  let mp = 1;
  let refs = 0;
  if (kind === 'create') {
    const { width, height } = resolvedSize(g);
    mp = (width * height) / 1024 ** 2;
  } else if (kind === 'edit') {
    refs = Math.max(0, body.refs.length - 1);
    mp = g.editResolution > 0 ? (g.editResolution / 1024) ** 2 : ((state.refs[0]?.w || 1024) * (state.refs[0]?.h || 1024)) / 1024 ** 2;
  } else {
    const src = findItem(extra.source?.galleryId || extra.source?.sessionId);
    const f = kind === 'upscale' ? extra.upscale?.factor || 2 : 1;
    mp = Math.min(extra.upscale?.maxMp || 16, (((src?.width || 1024) * f) * ((src?.height || 1024) * f)) / 1024 ** 2);
  }
  return guard.needGb(g.model, mp, refs);
}

async function cancelCurrent(all = false) {
  try {
    const active = activeJobs();
    if (!active.length) return;
    if (all) await api('POST', '/api/cancel', { all: true });
    else await api('POST', '/api/cancel', { id: active[0].id });
  } catch (e) { toast(e.message, 'error'); }
}

function renderQueue() {
  const active = activeJobs();
  const chips = active.map((j) => {
    const idx = j.batchTotal > 1 ? `${j.batchIndex + 1}/${j.batchTotal} · ` : '';
    const what = { upscale: 'Upscale', edit: 'Edit', vary: 'Vary' }[j.kind] || '';
    return `<span class="qchip ${j.status}" data-job="${j.id}" title="${esc(j.label)}"><span class="qdot"></span><span class="qlabel">${esc(idx)}${esc(what ? `${what}: ` : '')}${esc(j.label || '…')}</span><button data-cancel="${j.id}" title="Cancel">${icon('x')}</button></span>`;
  });
  if (active.length > 1) chips.push('<button class="qchip cancel-all" id="cancelAll">Cancel all</button>');
  $('#queue').innerHTML = chips.join('');
}

// ---------- stage ----------
function renderEmpty() {
  const st = state.status.state;
  const hasItem = !!findItem(state.selectedId);
  const showEmpty = !hasItem && state.view !== 'live';
  $('#empty').hidden = !showEmpty;
  if (!showEmpty) return;
  $('#emptyStart').hidden = st !== 'offline';
  if (st === 'offline') {
    $('#emptyTitle').textContent = 'ComfyUI is offline';
    $('#emptyText').innerHTML = 'Start it here, or just press <kbd>Ctrl</kbd> <kbd>↵</kbd> — Generate starts it for you.';
  } else if (st === 'starting') {
    $('#emptyTitle').textContent = 'Starting ComfyUI…';
    $('#emptyText').textContent = 'Usually 10–20 seconds. Progress is in the log panel below.';
  } else {
    $('#emptyTitle').textContent = 'Ready when you are';
    $('#emptyText').innerHTML = 'Write a prompt and press <kbd>Ctrl</kbd> <kbd>↵</kbd>.';
  }
}

function placeholderSrc(w, h) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#1b1e27"/><stop offset="1" stop-color="#121419"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`)}`;
}

function renderStage() {
  renderEmpty();
  const frame = $('#frame');
  const img = $('#stageImg');
  const prev = $('#previewImg');
  const live = state.view === 'live' && state.liveId && !FINAL.has(state.jobs.get(state.liveId)?.status);
  const item = findItem(state.selectedId);
  frame.hidden = !live && !item;
  frame.classList.toggle('live-mode', !!live);
  $('#live').hidden = !live;
  if (live) {
    const j = state.jobs.get(state.liveId);
    if (!prev.src || prev.dataset.job !== j.id) {
      prev.dataset.job = j.id;
      const w = j.width || 1024, h = j.height || 1024;
      prev.src = placeholderSrc(Math.round(w / 8), Math.round(h / 8));
      prev.classList.add('placeholder');
    }
    prev.hidden = false;
    renderLive();
  } else {
    prev.hidden = true;
    prev.removeAttribute('src');
    delete prev.dataset.job;
  }
  if (item) {
    if (img.dataset.id !== item.id) {
      img.dataset.id = item.id;
      img.src = item.url;
    }
    img.classList.toggle('alpha', !!item.hasAlpha);
  } else {
    img.removeAttribute('src');
    delete img.dataset.id;
  }
  renderDetails(live ? null : item);
  const list = visibleItems();
  const idx = list.findIndex((i) => i.id === state.selectedId);
  $('#navPrev').disabled = live || idx <= 0;
  $('#navNext').disabled = live || idx < 0 || idx >= list.length - 1;
  for (const c of $$('#grid .cell')) c.classList.toggle('sel', c.dataset.id === state.selectedId);
}

function renderLive(p) {
  const j = state.jobs.get(state.liveId);
  if (!j) return;
  const bar = $('#liveBar').parentElement;
  const sampling = j.node === '7' && j.step;
  bar.classList.toggle('indeterminate', !sampling);
  let phase = j.status === 'queued' ? 'Queued' : j.phase || 'Starting…';
  if (sampling) phase = `Sampling ${j.step}/${j.steps}`;
  const pct = sampling ? (j.step / j.steps) * 100 : 0;
  $('#liveBar').style.width = `${pct}%`;
  const bits = [];
  if (j.itps) bits.push(`${j.itps.toFixed(2)} it/s`);
  if (sampling && j.itps) bits.push(`~${formatDuration((j.steps - j.step) / j.itps + 0.8)} left`);
  if (j.startedAt) bits.push(`${((Date.now() - j.startedAt) / 1000).toFixed(0)} s`);
  if (j.batchTotal > 1) bits.push(`${j.batchIndex + 1} of ${j.batchTotal}`);
  if (j.incognito) bits.push('incognito');
  $('#livePhase').textContent = phase;
  $('#liveStats').textContent = bits.join(' · ');
  setTitle(sampling ? `${Math.round(pct)}%` : phase.replace('…', ''));
}
setInterval(() => { if (state.view === 'live') renderLive(); }, 1000);

// Progress in the window title (taskbar); a check mark waits there if a job finishes while you're away.
function setTitle(prefix) {
  document.title = prefix ? `${prefix} · Qwen Studio` : 'Qwen Studio';
}
function refreshTitle() {
  const running = activeJobs().find((j) => j.status === 'running');
  if (running) return;
  if (!activeJobs().length && document.hidden && state.finishedWhileHidden) setTitle('✓ Done');
  else if (!activeJobs().length) setTitle(null);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    state.finishedWhileHidden = false;
    refreshTitle();
  }
});

function detailChips(it) {
  const chips = [];
  const kindIcon = { edit: 'wand', upscale: 'upscale', vary: 'layers' }[it.kind] || null;
  if (kindIcon) chips.push(`<span class="dchip accent">${icon(kindIcon).replace('class="ic"', 'class="ic" style="width:12px;height:12px"')}${it.kind}</span>`);
  if (it.incognito) chips.push(`<span class="dchip accent">${icon('mask').replace('class="ic"', 'class="ic" style="width:12px;height:12px"')}session only</span>`);
  chips.push(`<span class="dchip"><b>${it.width}×${it.height}</b></span>`);
  chips.push(`<span class="dchip">${esc(it.model)}</span>`);
  chips.push(`<span class="dchip">${it.steps} · ${esc(it.sampler)}</span>`);
  if (it.cfg !== 1) chips.push(`<span class="dchip">cfg ${it.cfg}</span>`);
  if (it.kind === 'upscale' && it.denoise != null) chips.push(`<span class="dchip">×${it.factor} · strength ${it.denoise}</span>`);
  if (it.kind === 'vary') chips.push(`<span class="dchip">${esc(it.varyMode || 'variation')} · strength ${it.denoise}</span>`);
  chips.push(`<span class="dchip click" data-copy="${it.seed}" title="Copy seed">seed <b>${it.seed}</b></span>`);
  if (it.timing?.total_s) chips.push(`<span class="dchip" title="${it.timing.it_per_s ? it.timing.it_per_s + ' it/s' : ''}">${formatDuration(it.timing.total_s)}</span>`);
  if (it.hasAlpha) chips.push('<span class="dchip">alpha</span>');
  if (it.preset && it.preset !== 'custom') chips.push(`<span class="dchip">${esc(presetsFor(it.model)[it.preset]?.label || it.preset)}</span>`);
  chips.push(`<span class="dchip">${new Date(it.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`);
  return chips.join('');
}

function renderDetails(it) {
  $('#details').hidden = !it;
  if (!it) return;
  const label = { upscale: 'Upscaled', vary: 'Variation' }[it.kind];
  const text = it.kind === 'edit' ? it.editPrompt : label ? `${label}${it.prompt ? ' · ' + it.prompt : ''}` : it.prompt;
  $('#detailsPrompt').textContent = text || '(no prompt)';
  $('#detailsPrompt').title = 'Click to expand';
  $('#detailsChips').innerHTML = detailChips(it);
  $('#actStar').hidden = !!it.incognito;
  $('#actStar').classList.toggle('on', !!it.starred);
  $('#actKeep').hidden = !it.incognito;
  $('#actFolder').hidden = !!it.incognito;
  $('#actReuse').disabled = false;
  $('#actCompare').hidden = !compareSourceOf(it);
  $('#actCompare').classList.toggle('on', compare.isOpen());
}

// ---------- compare ----------
// The natural "before" for a result: the edit's input image, or the image an upscale/variation came from.
function compareSourceOf(it) {
  if (!it) return null;
  if (it.kind === 'edit' && it.refs?.length) return { url: `/outputs/${it.refs[0]}`, label: 'Input' };
  if ((it.kind === 'upscale' || it.kind === 'vary') && it.parent) return { id: it.parent, label: 'Original' };
  return null;
}

async function toggleCompare(it = selected(), other = null) {
  if (!it) return;
  if (compare.isOpen() && !other) { compare.close(); renderDetails(it); return; }
  let before = null;
  if (other) before = { url: other.url, label: other.id === it.parent ? 'Original' : `seed ${other.seed}` };
  else {
    const src = compareSourceOf(it);
    if (!src) return;
    if (src.url) before = src;
    else {
      const parent = findItem(src.id) || (await api('GET', `/api/gallery/${src.id}`).then((r) => r.item).catch(() => null));
      if (!parent) { toast('The original image is no longer in the gallery'); return; }
      before = { url: parent.url, label: src.label };
    }
  }
  state.view = 'item';
  renderStage();
  compare.open({ before: before.url, after: it.url, beforeLabel: before.label, afterLabel: other ? `seed ${it.seed}` : 'Result', alpha: !!it.hasAlpha });
  renderDetails(it);
}

// ---------- gallery ----------
const cellCache = new Map();
function visibleItems() {
  const f = state.ui?.galleryFilter || 'all';
  const q = ($('#gallerySearch').value || '').trim();
  const session = state.session.filter((i) => matchesSearch(i, q));
  if (f === 'session') return session;
  if (f === 'starred') return state.gallery.filter((i) => i.starred);
  return [...session, ...state.gallery];
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function cellFor(it) {
  let el = cellCache.get(it.id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cell';
    el.dataset.id = it.id;
    const badges = [];
    if (it.incognito) badges.push(`<span class="badge" title="Session only">${icon('mask')}</span>`);
    if (it.kind === 'edit') badges.push(`<span class="badge" title="Edit">${icon('wand')}</span>`);
    if (it.kind === 'upscale') badges.push(`<span class="badge" title="Upscaled">${icon('upscale')}</span>`);
    if (it.kind === 'vary') badges.push(`<span class="badge" title="Variation">${icon('layers')}</span>`);
    el.innerHTML = `<img alt="" loading="lazy" decoding="async"><div class="badges">${badges.join('')}</div>${it.incognito ? '' : `<button class="star" title="Star">${icon('star')}</button>`}`;
    const img = el.firstElementChild;
    img.onload = () => {
      img.classList.add('loaded');
      if (!it.thumb && !it.incognito && img.naturalWidth > 700) makeThumb(it, img);
    };
    img.src = it.thumb || it.url;
    cellCache.set(it.id, el);
  }
  el.classList.toggle('alpha', !!it.hasAlpha);
  el.classList.toggle('sel', it.id === state.selectedId);
  el.querySelector('.star')?.classList.toggle('on', !!it.starred);
  return el;
}

function renderGallery() {
  const list = visibleItems();
  const frag = document.createDocumentFragment();
  let group = null;
  for (const it of list) {
    const g = it.incognito ? 'Session · not saved' : dayLabel(it.createdAt);
    if (g !== group) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = g;
      frag.append(sep);
      group = g;
    }
    const cell = cellFor(it);
    if (state.newId === it.id) {
      cell.classList.remove('new');
      void cell.offsetWidth;
      cell.classList.add('new');
    }
    frag.append(cell);
  }
  state.newId = null;
  $('#grid').replaceChildren(frag);
  $('#gridEmpty').hidden = list.length > 0;
  $('#gridEmpty').textContent = state.ui.galleryFilter === 'starred' ? 'No starred images yet.' : state.ui.galleryFilter === 'session' ? 'No session images. Turn on incognito to generate without saving.' : 'No images yet.';
  const f = state.ui.galleryFilter;
  const sessionShown = f === 'starred' ? 0 : list.filter((i) => i.incognito).length;
  $('#galleryCount').textContent = `${f === 'session' ? sessionShown : (state.galleryTotal ?? state.gallery.length) + sessionShown}`;
  $('#sessionCount').textContent = state.session.length ? ` ${state.session.length}` : '';
  $('#sessionFilterBtn').hidden = !state.session.length && !state.ui.incognito;
  for (const b of $$('#galleryFilter button')) b.classList.toggle('on', b.dataset.filter === state.ui.galleryFilter);
  renderStage();
}

async function makeThumb(it, img) {
  try {
    const max = 360;
    const k = max / Math.max(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.84));
    const r = await api('POST', `/api/gallery/${it.id}/thumb`, blob);
    it.thumb = r.thumb;
  } catch { /* thumbs are an optimization only */ }
}

function selectItem(id) {
  if (state.selectedId !== id) compare.close();
  state.selectedId = id;
  state.view = 'item';
  renderStage();
  $(`#grid .cell[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function step(dir) {
  let list = visibleItems();
  const idx = list.findIndex((i) => i.id === state.selectedId);
  if (!list[idx + dir] && dir > 0 && (await loadMore())) list = visibleItems();
  const next = list[idx + dir];
  if (next) {
    selectItem(next.id);
    if (!$('#lightbox').hidden) openLightbox();
  }
}

// ---------- item actions ----------
const selected = () => findItem(state.selectedId);

function reuse(it = selected()) {
  if (!it) return;
  const common = { model: it.model, steps: it.steps, cfg: it.cfg, sampler: it.sampler, scheduler: it.scheduler, seed: it.seed, seedLocked: true, negative: it.negative || '' };
  if (it.cacheDevice) common.cacheDevice = it.cacheDevice;
  if (it.cacheDtype) common.cacheDtype = it.cacheDtype;
  if (it.kind === 'edit') {
    Object.assign(state.gen, common, { editPrompt: it.editPrompt, editResolution: it.editResolution ?? 1024, editTransparent: !!it.editTransparent });
    state.refs = (it.refs || []).map((rel, i) => ({ key: `r${Date.now()}${i}`, src: `/outputs/${rel}`, ref: { input: rel }, w: 0, h: 0 }));
    state.refs.forEach(measureRef);
    setUi({ tab: 'edit' });
  } else {
    const patch = { ...common, prompt: it.prompt || '' };
    if (it.kind === 'create') Object.assign(patch, { transparent: !!it.transparent, aspect: it.aspect, megapixels: it.megapixels, customSize: !!it.customSize, width: it.width, height: it.height });
    Object.assign(state.gen, patch);
    setUi({ tab: 'create' });
  }
  saveSoon();
  syncForm();
  renderRefs();
  toast(`Loaded settings · seed ${it.seed} locked`, 'ok');
}

function refFromItem(it) {
  return { key: `g${it.id}${Date.now()}`, src: it.url, ref: it.incognito ? { sessionId: it.id } : { galleryId: it.id }, w: it.width, h: it.height };
}

function sendToEdit(it = selected()) {
  if (!it) return;
  state.refs = [refFromItem(it), ...state.refs.filter((r) => r.src !== it.url)].slice(0, 10);
  setUi({ tab: 'edit' });
  syncForm();
  renderRefs();
  $('#editPrompt').focus();
}

function cutout(it = selected()) {
  if (!it) return;
  generate('edit', {
    refs: [refFromItem(it).ref],
    settings: { editPrompt: 'Remove the background, and output a PNG image', editTransparent: true, editResolution: 0, batch: 1, seedLocked: false },
  });
}

async function toggleStar(it = selected()) {
  if (!it || it.incognito) return;
  try {
    const r = await api('POST', `/api/gallery/${it.id}/star`, { starred: !it.starred });
    it.starred = r.item.starred;
    cellFor(it);
    renderDetails(it);
    if (state.ui.galleryFilter === 'starred') renderGallery();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteItem(it = selected()) {
  if (!it) return;
  if (!(await confirmModal('Delete image?', it.incognito ? 'Removes it from this session.' : 'The PNG and its settings file go to the Windows Recycle Bin.', 'Delete', true))) return;
  try {
    const list = visibleItems();
    const idx = list.findIndex((i) => i.id === it.id);
    if (it.incognito) {
      await api('DELETE', `/api/session/${it.id}`);
      state.session = state.session.filter((i) => i.id !== it.id);
    } else {
      await api('DELETE', `/api/gallery/${it.id}`);
      state.gallery = state.gallery.filter((i) => i.id !== it.id);
      state.galleryTotal = Math.max(0, state.galleryTotal - 1);
    }
    cellCache.delete(it.id);
    const next = list[idx + 1] || list[idx - 1];
    state.selectedId = next && next.id !== it.id ? next.id : null;
    renderGallery();
  } catch (e) { toast(e.message, 'error'); }
}

async function keepSessionItem(it = selected()) {
  if (!it?.incognito) return;
  try {
    const r = await api('POST', `/api/session/${it.id}/keep`);
    state.session = state.session.filter((i) => i.id !== it.id);
    state.gallery.unshift(r.item);
    state.galleryTotal++;
    state.selectedId = r.item.id;
    cellCache.delete(it.id);
    renderGallery();
    toast('Saved to gallery', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function copyImage(it = selected()) {
  if (!it) return;
  try {
    const blob = await (await fetch(it.url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied', 'ok', 1800);
  } catch (e) { toast(`Copy failed: ${e.message}`, 'error'); }
}

function openLightbox(it = selected()) {
  if (!it) return;
  const lb = $('#lightbox');
  lb.hidden = false;
  lb.classList.remove('zoom');
  $('#lbImg').src = it.url;
  $('#lbImg').classList.toggle('alpha', !!it.hasAlpha);
  $('#lbCaption').textContent = `${it.width}×${it.height} · seed ${it.seed} · ← → to browse · click to zoom`;
}

// ---------- upscale dialog ----------
function openUpscale(it = selected()) {
  if (!it) return;
  const g = state.gen;
  const local = { factor: g.upscaleFactor || 2, denoise: g.upscaleDenoise ?? 0.35, cap: (g.upscaleMaxMp || 4) <= 4 };
  const modal = $('#modal');
  const draw = () => {
    const maxMp = local.cap ? 4 : 16;
    let w = it.width * local.factor, h = it.height * local.factor;
    const mp0 = (w * h) / 1024 ** 2;
    if (mp0 > maxMp) { const k = Math.sqrt(maxMp / mp0); w *= k; h *= k; }
    w = snap(w); h = snap(h);
    const mp = (w * h) / 1024 ** 2;
    const steps = Math.max(1, Math.round(8 * local.denoise));
    const est = steps / itsFor(g.model, mp, state.ui.calib) + 2 + mp * 0.5;
    modal.innerHTML = `
      <h3>${icon('upscale')} Upscale & refine</h3>
      <p>Enlarges with Lanczos, then Turbo re-samples the tail of its 8-step schedule so the result gains detail. Uses this image's prompt and seed.${it.incognito || state.ui.incognito ? ' ' + incognitoSourceNote : ''}</p>
      <div class="row"><div class="field-head"><label>Scale</label></div>
        <div class="seg" id="upFactor">${[1.5, 2, 3].map((f) => `<button data-f="${f}" class="${local.factor === f ? 'on' : ''}">${f}×</button>`).join('')}</div></div>
      <div class="row"><label class="switch"><input type="checkbox" id="upCap" ${local.cap ? 'checked' : ''}><span class="track"></span><span>Cap at native 2K (4 MP) — recommended</span></label></div>
      <div class="row slider-field"><div class="field-head"><label>Refine strength</label><span class="mono">${local.denoise.toFixed(2)} · ${steps}/8</span></div>
        <input type="range" id="upDenoise" min="0.1" max="0.7" step="0.01" value="${local.denoise}" style="--fill:${((local.denoise - 0.1) / 0.6) * 100}%">
        <div class="hint">Low keeps it faithful · high invents more new detail (0.3–0.4 is the sweet spot)</div></div>
      <div class="sizes"><span>${it.width}×${it.height}</span><span class="arrow">→</span><b>${w}×${h}</b><span class="est">≈ ${formatDuration(est)}</span></div>
      <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn accent" id="upGo">${icon('upscale')}Upscale</button></div>`;
    $('#upFactor', modal).onclick = (e) => { const b = e.target.closest('button'); if (b) { local.factor = +b.dataset.f; draw(); } };
    $('#upCap', modal).onchange = (e) => { local.cap = e.target.checked; draw(); };
    $('#upDenoise', modal).oninput = (e) => { local.denoise = +e.target.value; draw(); };
    $('#upGo', modal).onclick = () => {
      closeModal();
      setGen({ upscaleFactor: local.factor, upscaleDenoise: local.denoise, upscaleMaxMp: local.cap ? 4 : 16 });
      generate('upscale', {
        source: it.incognito ? { sessionId: it.id } : { galleryId: it.id },
        upscale: { factor: local.factor, denoise: local.denoise, maxMp: local.cap ? 4 : 16 },
      });
    };
    const focusId = document.activeElement?.id;
    if (focusId) $('#' + focusId, modal)?.focus();
  };
  modal.onclick = null;
  draw();
  $('#modalWrap').hidden = false;
}

// ---------- variations ----------
// Re-samples the image itself at partial strength with new seeds: close alternatives, same composition.
const VARY = { subtle: { denoise: 0.42, label: 'Subtle', hint: 'Same scene, new details' }, strong: { denoise: 0.68, label: 'Strong', hint: 'Same idea, new take' } };
function openVary(it = selected()) {
  if (!it) return;
  const local = { mode: state.gen.varyMode || 'subtle', count: state.gen.varyCount || 4 };
  const modal = $('#modal');
  const draw = () => {
    const mp = (it.width * it.height) / 1024 ** 2;
    const steps = Math.max(1, Math.round(8 * VARY[local.mode].denoise));
    const est = (steps / itsFor(state.gen.model, mp, state.ui.calib) + 2) * local.count;
    modal.innerHTML = `
      <h3>${icon('layers')} Variations</h3>
      <p>Re-samples this image with new seeds, keeping its prompt, size and composition.${it.incognito || state.ui.incognito ? ' ' + incognitoSourceNote : ''}</p>
      <div class="row"><div class="vary-modes" id="varyMode">${Object.entries(VARY).map(([k, v]) => `
        <button class="${local.mode === k ? 'on' : ''}" data-m="${k}"><b>${v.label}</b><small>${v.hint}</small></button>`).join('')}</div></div>
      <div class="row"><div class="field-head"><label>How many</label></div>
        <div class="seg" id="varyCount">${[2, 4, 6].map((n) => `<button data-n="${n}" class="${local.count === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
      <div class="sizes"><span>${it.width}×${it.height}</span><span class="arrow">·</span><span>${steps} steps · ${state.gen.model}</span><span class="est">≈ ${formatDuration(est)}</span></div>
      <div class="foot"><button class="btn ghost" data-close>Cancel</button><button class="btn accent" id="varyGo">${icon('layers')}Make ${local.count}</button></div>`;
    $('#varyMode', modal).onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { local.mode = b.dataset.m; draw(); } };
    $('#varyCount', modal).onclick = (e) => { const b = e.target.closest('[data-n]'); if (b) { local.count = +b.dataset.n; draw(); } };
    $('#varyGo', modal).onclick = () => {
      closeModal();
      setGen({ varyMode: local.mode, varyCount: local.count });
      generate('vary', {
        source: it.incognito ? { sessionId: it.id } : { galleryId: it.id },
        vary: { denoise: VARY[local.mode].denoise, count: local.count, mode: local.mode },
      });
    };
    $('#varyGo', modal).focus();
  };
  modal.onclick = null;
  draw();
  $('#modalWrap').hidden = false;
}
const incognitoSourceNote = 'In incognito the source image passes through ComfyUI\'s input folder as a temporary file that is deleted when the job ends.';

// ---------- edit references ----------
function measureRef(r) {
  const im = new Image();
  im.onload = () => { r.w = im.naturalWidth; r.h = im.naturalHeight; renderRefs(); renderGenerateButton(); };
  im.src = r.src;
}

async function addFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  for (const f of imgs) {
    if (state.refs.length >= 10) { toast('Up to 10 images'); break; }
    const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(f); });
    const r = { key: `f${Date.now()}${Math.random()}`, src: dataUrl, ref: { dataUrl }, w: 0, h: 0, name: f.name };
    state.refs.push(r);
    measureRef(r);
  }
  if (state.ui.tab !== 'edit') { setUi({ tab: 'edit' }); syncForm(); }
  renderRefs();
}

function renderRefs() {
  const el = $('#refs');
  el.classList.toggle('empty', !state.refs.length);
  el.innerHTML = state.refs.map((r, i) => `
    <div class="ref ${i === 0 ? 'target' : ''}" data-i="${i}">
      <img src="${esc(r.src)}" alt="">
      <span class="tag" data-insert="${i}" title="${i === 0 ? 'Edit target' : 'Click to insert tag into the instruction'}">${i === 0 ? 'image1 · target' : `&lt;image${i + 1}&gt;`}</span>
      <div class="ref-tools">${i ? `<button data-target="${i}" title="Make this the edit target">${icon('star')}</button>` : ''}<button data-remove="${i}" title="Remove">${icon('x')}</button></div>
      ${r.w ? `<span class="dims">${r.w}×${r.h}</span>` : ''}
    </div>`).join('') + (state.refs.length < 10 ? `<button class="ref-add" id="refAdd">${icon('plus')}<span>${state.refs.length ? 'Add reference' : 'Drop, paste (Ctrl+V) or browse images'}</span></button>` : '');
  renderDerived();
}

// ---------- history popover ----------
function openHistory(kind, anchor) {
  const pop = $('#historyPop');
  pop.dataset.kind = kind;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - 440)}px`;
  pop.style.top = `${r.bottom + 6}px`;
  $('#histSearch').value = '';
  renderHistory();
  $('#histSearch').focus();
}
function renderHistory() {
  const pop = $('#historyPop');
  const kind = pop.dataset.kind;
  const f = pop.dataset.f || 'all';
  const q = $('#histSearch').value.trim().toLowerCase();
  for (const b of $$('#histFilter button')) b.classList.toggle('on', b.dataset.f === f);
  const list = state.history.filter((h) => (h.kind || 'create') === kind && (f === 'all' || h.fav) && (!q || h.prompt.toLowerCase().includes(q)));
  $('#histList').innerHTML = list.length ? list.slice(0, 200).map((h, i) => `
    <div class="hitem" data-i="${i}">
      <div style="flex:1;min-width:0"><p>${esc(h.prompt)}</p><div class="hmeta">${new Date(h.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${h.count > 1 ? ` · used ${h.count}×` : ''}</div></div>
      <button class="hbtn ${h.fav ? 'on' : ''}" data-fav="${i}" title="Favorite">${icon('star')}</button>
      <button class="hbtn" data-del="${i}" title="Remove from history">${icon('x')}</button>
    </div>`).join('') : `<div class="pop-empty">${f === 'fav' ? 'No favorites yet — star a prompt to keep it here.' : state.ui.incognito ? 'Incognito: new prompts are not recorded.' : 'Nothing yet.'}</div>`;
  $('#histList').onclick = async (e) => {
    const fav = e.target.closest('[data-fav]');
    const del = e.target.closest('[data-del]');
    const row = e.target.closest('.hitem');
    if (!row) return;
    const h = list[+row.dataset.i];
    if (fav) { state.history = await api('POST', '/api/history/fav', { prompt: h.prompt, fav: !h.fav }); renderHistory(); renderFavButton(); return; }
    if (del) { state.history = await api('DELETE', '/api/history', { prompt: h.prompt }); renderHistory(); return; }
    if (kind === 'edit') { $('#editPrompt').value = h.prompt; setGen({ editPrompt: h.prompt }); }
    else { $('#prompt').value = h.prompt; setGen({ prompt: h.prompt }); }
    pop.hidden = true;
  };
}

// ---------- logs ----------
function addLogs(lines, initial = false) {
  const box = $('#logsScroll');
  const follow = $('#logsFollow').checked && box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  for (const l of lines) {
    const existing = state.logIndex.get(l.id);
    if (existing) {
      Object.assign(existing.line, l);
      existing.el.className = `l l-${l.level}`;
      existing.el.lastChild.textContent = l.text;
      continue;
    }
    const el = document.createElement('div');
    el.className = `l l-${l.level}`;
    const t = new Date(l.t);
    el.innerHTML = `<span class="l-t">${t.toLocaleTimeString([], { hour12: false })}</span>`;
    el.append(document.createTextNode(l.text));
    box.append(el);
    state.logs.push(l);
    state.logIndex.set(l.id, { line: l, el });
    if (l.level === 'error' && !initial && !state.ui?.logOpen) state.logErrors++;
  }
  while (state.logs.length > 2500) {
    const old = state.logs.shift();
    state.logIndex.get(old.id)?.el.remove();
    state.logIndex.delete(old.id);
  }
  const last = state.logs[state.logs.length - 1];
  $('#logsLast').textContent = last ? last.text : '';
  $('#logsBadge').hidden = !state.logErrors;
  $('#logsBadge').textContent = `${state.logErrors} error${state.logErrors === 1 ? '' : 's'}`;
  if (follow || initial) box.scrollTop = box.scrollHeight;
}
function renderLogsOpen() {
  $('#logs').classList.toggle('open', !!state.ui.logOpen);
  if (state.ui.logOpen) {
    state.logErrors = 0;
    $('#logsBadge').hidden = true;
    const box = $('#logsScroll');
    requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }
}
function toggleLogs() {
  setUi({ logOpen: !state.ui.logOpen });
  renderLogsOpen();
}

// ---------- system drawer ----------
function renderSystem() {
  const sys = state.system || {};
  const gpu = sys.gpu;
  if (gpu) {
    const pct = gpu.usedMB / gpu.totalMB;
    const bar = $('#vramBar');
    bar.style.width = `${pct * 100}%`;
    bar.className = pct > 0.85 ? 'high' : pct > 0.6 ? 'mid' : '';
    $('#vramVal').textContent = `${(gpu.usedMB / 1024).toFixed(1)} / ${(gpu.totalMB / 1024).toFixed(1)} GB`;
  }
  const ol = sys.ollama || { online: false, models: [] };
  const olBtn = $('#ollamaBtn');
  olBtn.classList.toggle('online', ol.online);
  olBtn.classList.toggle('loaded', ol.models.length > 0);
  const olVram = ol.models.reduce((s, m) => s + (m.sizeVram || 0), 0);
  $('#ollamaLabel').textContent = !ol.online ? 'Ollama off' : ol.models.length ? `Ollama · ${ol.models.length} · ${gb(olVram)} GB` : 'Ollama idle';

  if (!$('#drawer').classList.contains('open')) return;
  const c = sys.comfy;
  const st = state.status;
  const up = st.startedAt ? formatDuration((Date.now() - st.startedAt) / 1000) : '–';
  $('#drawerBody').innerHTML = `
    <div class="sys-sec">
      <h4>${icon('chip')}GPU</h4>
      ${gpu ? `<div class="bigbar"><i style="width:${(gpu.usedMB / gpu.totalMB) * 100}%"></i></div>
      <dl class="kv"><dt>Card</dt><dd>${esc(gpu.name)}</dd><dt>VRAM used</dt><dd>${(gpu.usedMB / 1024).toFixed(2)} / ${(gpu.totalMB / 1024).toFixed(2)} GB (all apps)</dd>
      <dt>Utilization</dt><dd>${gpu.util}%</dd><dt>Temperature</dt><dd>${gpu.temp} °C</dd></dl>` : '<p class="muted">nvidia-smi not available.</p>'}
    </div>
    <div class="sys-sec">
      <h4>${icon('layers')}ComfyUI<span class="grow"></span>
        <button class="btn btn-xs ${st.state === 'offline' ? 'go' : 'stop'}" id="sysComfy">${st.state === 'offline' ? `${icon('play')}Start` : `${icon('stop')}Kill`}</button>
        <button class="btn btn-xs ghost" id="sysFree" ${['ready', 'busy'].includes(st.state) ? '' : 'disabled'}>${icon('zap')}Free VRAM</button></h4>
      <dl class="kv"><dt>Status</dt><dd>${esc(STATE_LABEL[st.state] || st.state)}${st.owned ? ` · PID ${st.pid}` : st.state !== 'offline' ? ' · external' : ''}</dd>
      <dt>Uptime</dt><dd>${up}</dd>
      ${c ? `<dt>Free VRAM</dt><dd>${gb(c.vramFree)} of ${gb(c.vramTotal)} GB (ComfyUI's view)</dd><dt>System RAM</dt><dd>${gb(c.ramTotal - c.ramFree)} / ${gb(c.ramTotal)} GB</dd><dt>Version</dt><dd>ComfyUI ${esc(c.version || '?')} · torch ${esc((c.pytorch || '').split('+')[0])}</dd>` : ''}
      <dt>URL</dt><dd>${esc(st.url || state.app.comfyUrl)}</dd><dt>Install</dt><dd>${esc(state.app.comfyRoot)}</dd></dl>
    </div>
    <div class="sys-sec" id="ollamaSec">
      <h4>${icon('spark')}Ollama<span class="grow"></span>${ol.models.length > 1 ? `<button class="btn btn-xs ghost" id="olAll">Unload all</button>` : ''}</h4>
      ${!ol.online ? `<div class="olm"><div class="grow"><b>Not running</b><span class="mono">nothing on ${esc(state.app.ollamaUrl || '127.0.0.1:11434')}</span></div>${ol.canStart ? `<button class="btn btn-xs go" id="sysStartOllama">${icon('play')}Start Ollama</button>` : ''}</div>` : ol.models.length ? ol.models.map((m) => `
        <div class="olm"><div class="grow"><b>${esc(m.name)}</b><span class="mono">${gb(m.sizeVram)} GB VRAM${m.size > m.sizeVram ? ` · ${gb(m.size - m.sizeVram)} GB RAM` : ''}${m.expiresAt ? ` · until ${new Date(m.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span></div>
        <button class="btn btn-xs" data-unload="${esc(m.name)}">Unload</button></div>`).join('') : '<p class="muted">Running, no models loaded.</p>'}
      <div class="field-head" style="margin-top:12px"><label>When a run needs the GPU</label></div>
      <div class="seg seg-sm" id="guardSeg">${[['ask', 'Ask first'], ['auto', 'Unload Ollama'], ['off', 'Do nothing']].map(([v, l]) => `<button data-guard="${v}" class="${(state.ui.vramGuard || 'ask') === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="hint" style="margin:8px 0 0">Prompt enhancer: ${esc(state.app.enhancerSource || 'official template')} instructions, run on your Ollama model${state.ui.enhanceModel ? ` (<b>${esc(state.ui.enhanceModel)}</b>)` : ''}.</p>
    </div>
    <div class="sys-sec">
      <h4>${icon('folder')}Storage</h4>
      <dl class="kv"><dt>Images</dt><dd>${esc(state.app.outputDir)}</dd></dl>
      <div style="display:flex;gap:6px;margin-top:10px"><button class="btn btn-xs" id="sysOpenOut">${icon('folder')}Open images folder</button><button class="btn btn-xs ghost" id="sysOpenComfy">${icon('folder')}ComfyUI folder</button></div>
    </div>
    <div class="sys-sec">
      <h4>${icon('terminal')}Shortcuts</h4>
      <div class="shortcuts">
        <span><kbd>Ctrl</kbd> <kbd>↵</kbd></span><span>Generate / apply edit</span>
        <span><kbd>Ctrl</kbd> <kbd>.</kbd></span><span>Cancel current job (right-click ■ cancels all)</span>
        <span><kbd>Ctrl</kbd> <kbd>L</kbd></span><span>Toggle log panel</span>
        <span><kbd>1</kbd>–<kbd>4</kbd></span><span>Fast · Normal · Quality · Max</span>
        <span><kbd>←</kbd> <kbd>→</kbd></span><span>Browse images</span>
        <span><kbd>F</kbd></span><span>Full screen</span>
        <span><kbd>R</kbd> <kbd>E</kbd> <kbd>U</kbd> <kbd>V</kbd></span><span>Reuse · Edit · Upscale · Vary</span>
        <span><kbd>C</kbd> / <kbd>Alt</kbd>+click</span><span>Compare with source / with any image</span>
        <span><kbd>S</kbd> · <kbd>Del</kbd></span><span>Star · Delete (Recycle Bin)</span>
        <span><kbd>Ctrl</kbd> <kbd>V</kbd></span><span>Paste an image into Edit</span>
        <span>Drag</span><span>Gallery → Explorer saves a copy · → Edit panel adds it</span>
      </div>
    </div>`;
}

function openDrawer(scrollTo) {
  $('#drawer').classList.add('open');
  $('#scrim').hidden = false;
  renderSystem();
  if (scrollTo) $(scrollTo)?.scrollIntoView({ block: 'start' });
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').hidden = true;
}

// ---------- incognito / quit ----------
function renderIncognito() {
  const on = !!state.ui.incognito;
  $('#incognitoBtn').classList.toggle('on', on);
  $('#incognitoBanner').hidden = !on;
  document.body.classList.toggle('incognito', on);
  renderGallery();
}

function showClosed() {
  document.body.innerHTML = `<div style="height:100vh;display:grid;place-items:center;text-align:center;color:#858b98;font:14px 'Segoe UI',system-ui">
    <div><img src="/icon.svg" alt="" style="width:48px;opacity:.6">
    <h2 style="color:#e8e9ee;font-weight:600;margin:12px 0 6px">Qwen Studio has closed</h2><p>You can close this window. Launch it again from the desktop shortcut.</p></div></div>`;
  setTimeout(() => window.close(), 400);
}

// Downscaled JPEG data URL (for sending reference images to a vision LLM without huge payloads).
async function shrinkImage(src, max) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * k);
  c.height = Math.round(img.naturalHeight * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

// ---------- UI wiring ----------
function bindUi() {
  // tabs
  $$('.tab').forEach((t) => t.addEventListener('click', () => { setUi({ tab: t.dataset.tab }); $('#app').dataset.tab = t.dataset.tab; renderDerived(); }));

  // prompts
  $('#prompt').addEventListener('input', (e) => { setGen({ prompt: e.target.value }); enhance.onPromptEdited('create'); });
  $('#editPrompt').addEventListener('input', (e) => { setGen({ editPrompt: e.target.value }); enhance.onPromptEdited('edit'); });
  enhance.init({
    state,
    setUi,
    getText: (kind) => (kind === 'edit' ? state.gen.editPrompt : state.gen.prompt),
    setText: (kind, text) => {
      const ta = kind === 'edit' ? $('#editPrompt') : $('#prompt');
      ta.value = text;
      setGen(kind === 'edit' ? { editPrompt: text } : { prompt: text });
    },
    refImages: (n) => Promise.all(state.refs.slice(0, n).map((r) => shrinkImage(r.src, 768))),
  });
  $('#negative').addEventListener('input', (e) => setGen({ negative: e.target.value }));
  $('#transparent').addEventListener('change', (e) => setGen({ transparent: e.target.checked }));
  $('#editTransparent').addEventListener('change', (e) => setGen({ editTransparent: e.target.checked }));
  for (const id of ['#negToggle', '#negToggle2']) $(id).addEventListener('click', () => { setUi({ negativeOpen: !state.ui.negativeOpen }); $('#negGroup').hidden = !state.ui.negativeOpen; if (state.ui.negativeOpen) $('#negative').focus(); });
  $('#favPromptBtn').addEventListener('click', async () => {
    const p = state.gen.prompt.trim();
    if (!p) return toast('Write a prompt first');
    const fav = !state.history.find((h) => h.prompt === p && h.fav);
    state.history = await api('POST', '/api/history/fav', { prompt: p, fav });
    renderFavButton();
    toast(fav ? 'Added to favorites' : 'Removed from favorites', 'ok', 1600);
  });
  $$('[data-history]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openHistory(b.dataset.history, b); }));
  $('#histFilter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { $('#historyPop').dataset.f = b.dataset.f; renderHistory(); } });
  $('#histSearch').addEventListener('input', renderHistory);
  document.addEventListener('click', (e) => { if (!e.target.closest('#historyPop') && !e.target.closest('[data-history]')) $('#historyPop').hidden = true; });

  // presets / size / model
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const p = presetsFor(state.gen.model)[b.dataset.preset];
    setGen({ model: p.model, megapixels: p.megapixels, steps: p.steps, cfg: p.cfg, sampler: p.sampler, scheduler: p.scheduler, customSize: false });
    syncForm();
  });
  $('#aspects').addEventListener('click', (e) => { const b = e.target.closest('[data-aspect]'); if (b) setGen({ aspect: b.dataset.aspect, customSize: false }); $('#customToggle').checked = false; });
  $('#mpSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-mp]'); if (b) setGen({ megapixels: +b.dataset.mp }); });
  $('#customToggle').addEventListener('change', (e) => {
    const { width, height } = resolvedSize(state.gen);
    setGen({ customSize: e.target.checked, width, height });
  });
  const wh = () => setGen({ width: snap(+$('#width').value || 1024), height: snap(+$('#height').value || 1024) });
  $('#width').addEventListener('change', wh);
  $('#height').addEventListener('change', wh);
  $('#swapWH').addEventListener('click', () => { $('#width').value = state.gen.height; $('#height').value = state.gen.width; wh(); });
  $('#editResSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-res]'); if (b) setGen({ editResolution: +b.dataset.res }); });
  $('#modelSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]');
    if (!b || b.disabled) return;
    const p = state.app.profiles?.[b.dataset.model];
    const patch = { model: b.dataset.model };
    if (p?.cacheDevice) patch.cacheDevice = p.cacheDevice;
    if (p?.cacheDtype) patch.cacheDtype = p.cacheDtype;
    if (!state.gen.customSize && p?.maxMp && state.gen.megapixels > p.maxMp) patch.megapixels = p.defaultMp || p.maxMp;
    setGen(patch);
  });

  // seed / batch
  $('#seed').addEventListener('input', (e) => {
    const v = e.target.value.replace(/\D/g, '');
    e.target.value = v;
    if (v) setGen({ seed: Math.min(Number(v), Number.MAX_SAFE_INTEGER), seedLocked: true });
  });
  $('#seedDice').addEventListener('click', () => { setGen({ seed: Math.floor(Math.random() * 2 ** 47), seedLocked: true }); });
  $('#seedLock').addEventListener('click', () => {
    if (state.gen.seedLocked) setGen({ seedLocked: false });
    else setGen({ seedLocked: true, seed: state.lastSeed ?? state.gen.seed });
  });
  $('#seedLast').addEventListener('click', (e) => { if (e.target.id === 'lockLast') setGen({ seed: state.lastSeed, seedLocked: true }); });
  $('#batchMinus').addEventListener('click', () => setGen({ batch: Math.max(1, state.gen.batch - 1) }));
  $('#batchPlus').addEventListener('click', () => setGen({ batch: Math.min(32, state.gen.batch + 1) }));
  $('#batch').addEventListener('change', (e) => setGen({ batch: Math.min(32, Math.max(1, Math.round(+e.target.value) || 1)) }));

  // advanced
  $('#advanced').addEventListener('toggle', () => setUi({ advancedOpen: $('#advanced').open }));
  $('#steps').addEventListener('input', (e) => { $('#stepsNum').value = e.target.value; setGen({ steps: +e.target.value }); });
  $('#stepsNum').addEventListener('change', (e) => { const v = Math.min(200, Math.max(1, Math.round(+e.target.value) || 1)); e.target.value = v; $('#steps').value = Math.min(80, v); setGen({ steps: v }); });
  $('#cfg').addEventListener('input', (e) => { $('#cfgNum').value = e.target.value; setGen({ cfg: +e.target.value }); });
  $('#cfgNum').addEventListener('change', (e) => { const v = Math.min(30, Math.max(0, +e.target.value || 1)); e.target.value = v; $('#cfg').value = Math.max(1, Math.min(8, v)); setGen({ cfg: v }); });
  for (const id of ['sampler', 'scheduler', 'cacheDevice', 'cacheDtype']) $('#' + id).addEventListener('change', (e) => setGen({ [id]: e.target.value }));
  $('#resetBtn').addEventListener('click', async () => {
    if (!(await confirmModal('Reset to defaults?', 'Restores the Normal preset, size, sampler and other settings. Prompts are cleared; your gallery and history are kept.', 'Reset'))) return;
    const r = await api('POST', '/api/settings/reset');
    state.gen = r.settings.gen;
    state.ui = r.settings.ui;
    syncForm();
    renderIncognito();
    toast('Settings reset', 'ok');
  });
  $('#openOutputs').addEventListener('click', () => api('POST', '/api/open', { target: 'outputs' }));

  // generate / cancel
  $('#generateBtn').addEventListener('click', () => generate());
  $('#cancelBtn').addEventListener('click', () => cancelCurrent(false));
  $('#cancelBtn').addEventListener('contextmenu', (e) => { e.preventDefault(); cancelCurrent(true); });
  $('#liveCancel').addEventListener('click', () => cancelCurrent(false));
  $('#queue').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c) return api('POST', '/api/cancel', { id: c.dataset.cancel }).catch((err) => toast(err.message, 'error'));
    if (e.target.closest('#cancelAll')) return cancelCurrent(true);
    const chip = e.target.closest('.qchip.running');
    if (chip) { state.view = 'live'; state.liveId = chip.dataset.job; renderStage(); }
    return undefined;
  });

  // comfy / system
  $('#comfyBtn').addEventListener('click', toggleComfy);
  $('#emptyStart').addEventListener('click', toggleComfy);
  $('#freeBtn').addEventListener('click', async () => { try { await api('POST', '/api/comfy/free'); toast('ComfyUI models unloaded', 'ok'); } catch (e) { toast(e.message, 'error'); } });
  $('#vramMeter').addEventListener('click', () => openDrawer());
  $('#systemBtn').addEventListener('click', () => openDrawer());
  $('#ollamaBtn').addEventListener('click', () => openDrawer('#ollamaSec'));
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#drawerBody').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.id === 'sysComfy') await toggleComfy();
      if (t.id === 'sysFree') { await api('POST', '/api/comfy/free'); toast('ComfyUI models unloaded', 'ok'); }
      if (t.id === 'sysOpenOut') await api('POST', '/api/open', { target: 'outputs' });
      if (t.id === 'sysOpenComfy') await api('POST', '/api/open', { target: 'comfy' });
      if (t.dataset.guard) { setUi({ vramGuard: t.dataset.guard }); renderSystem(); }
      if (t.id === 'sysStartOllama') {
        t.disabled = true;
        t.textContent = 'Starting…';
        await api('POST', '/api/ollama/start');
        toast('Ollama is running', 'ok', 2000);
      }
      if (t.dataset.unload || t.id === 'olAll') {
        t.disabled = true;
        const r = await api('POST', '/api/ollama/unload', t.id === 'olAll' ? { all: true } : { model: t.dataset.unload });
        const failed = r.results.filter((x) => !x.ok);
        toast(failed.length ? `Could not unload ${failed.map((f) => f.model).join(', ')}` : `Unloaded ${r.results.map((x) => x.model).join(', ')}`, failed.length ? 'error' : 'ok');
      }
    } catch (err) { toast(err.message, 'error'); }
  });

  // incognito / quit
  const setIncognito = (on) => {
    setUi({ incognito: on, galleryFilter: on ? state.ui.galleryFilter : state.ui.galleryFilter === 'session' && !state.session.length ? 'all' : state.ui.galleryFilter });
    renderIncognito();
    toast(on ? 'Incognito on — new results stay in memory only' : state.session.length ? 'Incognito off — session images stay until you quit (use ⤓ to save one)' : 'Incognito off', 'ok');
  };
  $('#incognitoBtn').addEventListener('click', () => setIncognito(!state.ui.incognito));
  $('#incognitoOff').addEventListener('click', () => setIncognito(false));
  $('#quitBtn').addEventListener('click', async () => {
    const owned = state.status.owned;
    if (!(await confirmModal('Quit Qwen Studio?', owned ? 'The ComfyUI process Qwen Studio started will be stopped too, freeing its VRAM.' : 'The app server will close.', 'Quit'))) return;
    await api('POST', '/api/quit').catch(() => {});
    showClosed();
  });

  // stage / details
  $('#stageImg').addEventListener('click', () => openLightbox());
  $('#navPrev').addEventListener('click', () => step(-1));
  $('#navNext').addEventListener('click', () => step(1));
  $('#detailsPrompt').addEventListener('click', (e) => e.target.classList.toggle('expanded'));
  $('#detailsChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Seed copied', 'ok', 1500));
  });
  $('#actReuse').addEventListener('click', () => reuse());
  $('#actEdit').addEventListener('click', () => sendToEdit());
  $('#actUpscale').addEventListener('click', () => openUpscale());
  $('#actBgRemove').addEventListener('click', () => cutout());
  $('#actVary').addEventListener('click', () => openVary());
  $('#actCompare').addEventListener('click', () => toggleCompare());
  $('#actStar').addEventListener('click', () => toggleStar());
  $('#actKeep').addEventListener('click', () => keepSessionItem());
  $('#actCopy').addEventListener('click', () => copyImage());
  $('#actFolder').addEventListener('click', () => { const it = selected(); if (it) api('POST', '/api/open', { galleryId: it.id }); });
  $('#actFull').addEventListener('click', () => openLightbox());
  $('#actDelete').addEventListener('click', () => deleteItem());

  // gallery
  $('#grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const it = findItem(cell.dataset.id);
    if (e.target.closest('.star')) { toggleStar(it); return; }
    if (e.altKey && selected() && it && it.id !== state.selectedId) { toggleCompare(selected(), it); return; }
    selectItem(cell.dataset.id);
  });

  // Drag an image out of the app (Explorer/desktop gets a real PNG) or onto the Edit panel.
  const onDragStart = (e, it) => {
    if (!it) return;
    const abs = new URL(it.url, location.origin).href;
    const name = it.file || `qwen-studio-${it.seed}.png`;
    e.dataTransfer.setData('DownloadURL', `image/png:${name}:${abs}`);
    e.dataTransfer.setData('text/uri-list', abs);
    e.dataTransfer.setData('application/x-qs-item', it.id);
    e.dataTransfer.effectAllowed = 'copy';
    document.body.classList.add('dragging-item');
  };
  $('#grid').addEventListener('dragstart', (e) => onDragStart(e, findItem(e.target.closest('.cell')?.dataset.id)));
  $('#stageImg').addEventListener('dragstart', (e) => onDragStart(e, selected()));
  document.addEventListener('dragend', () => document.body.classList.remove('dragging-item'));
  const controls = $('.controls');
  controls.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-qs-item')) return;
    e.preventDefault();
    controls.classList.add('drop-target');
  });
  controls.addEventListener('dragleave', (e) => { if (!controls.contains(e.relatedTarget)) controls.classList.remove('drop-target'); });
  controls.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('application/x-qs-item');
    controls.classList.remove('drop-target');
    document.body.classList.remove('dragging-item');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const it = findItem(id);
    if (!it) return;
    if (state.refs.length >= 10) { toast('Up to 10 images'); return; }
    state.refs.push(refFromItem(it));
    if (state.ui.tab !== 'edit') { setUi({ tab: 'edit' }); syncForm(); }
    renderRefs();
    toast(state.refs.length === 1 ? 'Added as the image to edit' : `Added as <image${state.refs.length}>`, 'ok', 1800);
  });
  $('#grid').addEventListener('dblclick', (e) => { if (e.target.closest('.cell')) openLightbox(); });
  $('#grid').addEventListener('scroll', (e) => {
    const g = e.target;
    if (g.scrollTop + g.clientHeight > g.scrollHeight - 600) loadMore();
  });
  $('#galleryFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    const before = state.ui.galleryFilter;
    setUi({ galleryFilter: b.dataset.filter });
    // "session" is client-side; all/starred need the server's list.
    if (b.dataset.filter !== 'session' && (before === 'starred') !== (b.dataset.filter === 'starred')) loadGallery();
    else renderGallery();
  });
  let searchTimer;
  $('#gallerySearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadGallery, 200); });

  // edit refs
  $('#refs').addEventListener('click', (e) => {
    if (e.target.closest('#refAdd')) return $('#refFile').click();
    const rm = e.target.closest('[data-remove]');
    const tg = e.target.closest('[data-target]');
    const ins = e.target.closest('[data-insert]');
    if (rm) state.refs.splice(+rm.dataset.remove, 1);
    else if (tg) state.refs.unshift(...state.refs.splice(+tg.dataset.target, 1));
    else if (ins && +ins.dataset.insert > 0) {
      const ta = $('#editPrompt');
      const tag = `<image${+ins.dataset.insert + 1}>`;
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + tag + ta.value.slice(ta.selectionEnd ?? pos);
      setGen({ editPrompt: ta.value });
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos + tag.length;
      return undefined;
    } else return undefined;
    renderRefs();
    return undefined;
  });
  $('#refFile').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#quickEdits').innerHTML = QUICK_EDITS.map((q, i) => `<button data-q="${i}">${icon(q.icon)}${esc(q.label)}</button>`).join('');
  $('#quickEdits').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b) return;
    const q = QUICK_EDITS[+b.dataset.q];
    $('#editPrompt').value = q.prompt;
    setGen({ editPrompt: q.prompt, editTransparent: !!q.transparent });
    $('#editTransparent').checked = !!q.transparent;
  });

  // drag & drop / paste
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#dropVeil').hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropVeil').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropVeil').hidden = true;
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  // logs
  $('#logsHead').addEventListener('click', toggleLogs);
  $('#logsErrorsOnly').addEventListener('change', (e) => $('#logsScroll').classList.toggle('errors-only', e.target.checked));
  $('#logsClear').addEventListener('click', () => { $('#logsScroll').replaceChildren(); state.logs = []; state.logIndex.clear(); });
  $('#logsCopy').addEventListener('click', () => navigator.clipboard.writeText(state.logs.map((l) => l.text).join('\n')).then(() => toast('Log copied', 'ok', 1500)));

  // modal / lightbox
  $('#modalWrap').addEventListener('click', (e) => { if (e.target.id === 'modalWrap' || e.target.closest('[data-close]')) closeModal(null); });
  $('#lbClose').addEventListener('click', () => { $('#lightbox').hidden = true; });
  $('#lbPrev').addEventListener('click', () => step(-1));
  $('#lbNext').addEventListener('click', () => step(1));
  $('#lbImg').addEventListener('click', () => $('#lightbox').classList.toggle('zoom'));
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').hidden = true; });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); generate(); return; }
    if (mod && e.key === '.') { e.preventDefault(); cancelCurrent(e.shiftKey); return; }
    if (mod && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); toggleLogs(); return; }
    if (e.key === 'Escape') {
      if (!$('#modalWrap').hidden) return closeModal(null);
      if (compare.isOpen()) { compare.close(); renderDetails(selected()); return undefined; }
      if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return undefined; }
      if (!$('#historyPop').hidden) { $('#historyPop').hidden = true; return undefined; }
      if ($('#drawer').classList.contains('open')) return closeDrawer();
      return undefined;
    }
    if (e.target.matches('input, textarea, select') || mod || e.altKey || !$('#modalWrap').hidden) return undefined;
    const k = e.key.toLowerCase();
    const actions = {
      1: () => $(`[data-preset="${PRESET_ORDER[0]}"]`)?.click(),
      2: () => $(`[data-preset="${PRESET_ORDER[1]}"]`)?.click(),
      3: () => $(`[data-preset="${PRESET_ORDER[2]}"]`)?.click(),
      4: () => $(`[data-preset="${PRESET_ORDER[3]}"]`)?.click(),
      // While comparing, the arrows move the divider instead of browsing.
      arrowleft: () => (compare.isOpen() ? compare.nudge(e.shiftKey ? -20 : -5) : step(-1)),
      arrowright: () => (compare.isOpen() ? compare.nudge(e.shiftKey ? 20 : 5) : step(1)),
      s: () => toggleStar(),
      e: () => sendToEdit(),
      u: () => openUpscale(),
      v: () => openVary(),
      c: () => toggleCompare(),
      r: () => reuse(),
      f: () => ($('#lightbox').hidden ? openLightbox() : ($('#lightbox').hidden = true)),
      ' ': () => ($('#lightbox').hidden ? openLightbox() : ($('#lightbox').hidden = true)),
      delete: () => deleteItem(),
    };
    if (actions[k]) {
      // Stop the key from also landing in whatever the action focuses (e.g. E focuses the instruction box).
      e.preventDefault();
      actions[k]();
    }
    return undefined;
  });

  renderRefs();
}

connect();

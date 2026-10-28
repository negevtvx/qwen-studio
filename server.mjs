// Qwen Studio — local front-end for Qwen Image 2.1 Turbo. Pick a 12, 16, or 24 GB model pack. Zero dependencies (Node 22+).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Settings, History, Gallery, readJson, writeJson } from './lib/store.mjs';
import { ComfyManager } from './lib/comfy.mjs';
import { buildCreate, buildEdit, buildUpscale, upscaleTarget } from './lib/workflow.mjs';
import { resolvedSize, matchPreset, estimateSeconds, calibKey, snap } from './public/shared.mjs';
import { pngInfo } from './lib/png.mjs';
import * as sys from './lib/sys.mjs';
import * as ollama from './lib/ollama.mjs';
import { loadEnhancerPrompts, tidy } from './lib/enhance.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
await fsp.mkdir(DATA, { recursive: true });

const settings = new Settings(ROOT);
await settings.load();
const app = settings.app;
// Timing calibration is keyed "model@megapixels"; drop anything in an older format.
for (const k of Object.keys(settings.data.ui.calib || {})) if (!k.includes('@')) delete settings.data.ui.calib[k];
const OUTPUTS = settings.resolvePath(app.outputDir);
const COMFY_INPUT = path.join(app.comfyRoot || '', 'ComfyUI', 'input', 'qwenstudio');
const OLLAMA = (process.env.QS_OLLAMA_URL || app.ollamaUrl).replace(/\/+$/, '');
const enhancerPrompts = loadEnhancerPrompts(app.comfyRoot);

const gallery = new Gallery(OUTPUTS);
await gallery.load();
const history = new History(path.join(DATA, 'history.json'));
await history.load();
const INFO_FILE = path.join(DATA, 'comfy-info.json');
let comfyInfo = await readJson(INFO_FILE, null);
const comfy = new ComfyManager(app);

// Incognito results live only in memory and are never written by Qwen Studio.
const session = new Map();
const SESSION_MAX = 60;

// ---------- server-sent events ----------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

comfy.on('status', (s) => broadcast('status', s));
comfy.on('logs', (lines) => broadcast('logs', lines));
comfy.on('job', (j) => broadcast('job', j));
comfy.on('progress', (p) => broadcast('progress', p));
comfy.on('preview', (p) => broadcast('preview', p));
comfy.on('info', (info) => {
  comfyInfo = info;
  writeJson(INFO_FILE, info).catch(() => {});
  broadcast('info', info);
});

comfy.on('image', async ({ job, buf }) => {
  try {
    const timing = {
      total_s: job.startedAt ? +((Date.now() - job.startedAt) / 1000).toFixed(1) : null,
      it_per_s: job.itps ? +job.itps.toFixed(3) : null,
    };
    const meta = { ...job.meta, timing, jobId: job.id };
    let item;
    if (job.incognito) {
      const id = `ses_${crypto.randomBytes(6).toString('hex')}`;
      const info = pngInfo(buf) || {};
      item = { ...meta, id, incognito: true, createdAt: new Date().toISOString(), width: info.width, height: info.height, hasAlpha: !!info.hasAlpha, url: `/api/session/${id}` };
      session.set(id, { buf, item });
      while (session.size > SESSION_MAX) session.delete(session.keys().next().value);
    } else {
      item = await gallery.add(buf, meta);
    }
    job.items = [...(job.items || []), item.id];
    broadcast('image', item);
  } catch (e) {
    comfy.sys(`Could not save image: ${e.message}`, 'error');
  }
});

comfy.on('finished', async (job) => {
  // Only plain text-to-image runs have a known canvas size; they teach the time estimates.
  if (job.status === 'done' && job.kind === 'create' && job.itps > 0 && job.meta?.width) {
    const mp = (job.meta.width * job.meta.height) / (1024 * 1024);
    broadcast('calib', { key: calibKey(job.meta.model, mp), itps: job.itps });
  }
  if (job.incognito) {
    await comfy.forgetHistory(job.id);
    for (const name of job.tempUploads || []) fsp.rm(path.join(COMFY_INPUT, name), { force: true }).catch(() => {});
  }
  maybeQuitSoon();
});

// ---------- generation ----------

const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
const randomSeed = () => crypto.randomInt(0, 2 ** 47);

function sanitize(raw) {
  const d = settings.defaults.gen;
  const g = { ...d, ...raw };
  const ids = Object.keys(app.profiles || {});
  g.model = ids.includes(String(g.model)) ? String(g.model) : (ids.includes(String(app.vram)) ? String(app.vram) : ids[0]);
  g.steps = Math.round(clamp(g.steps, 1, 200, d.steps));
  g.cfg = clamp(g.cfg, 0, 30, d.cfg);
  g.batch = Math.round(clamp(g.batch, 1, 32, 1));
  g.seed = Math.round(clamp(g.seed, 0, Number.MAX_SAFE_INTEGER, d.seed));
  g.megapixels = clamp(g.megapixels, 0.1, 16, d.megapixels);
  g.editResolution = Math.round(clamp(g.editResolution, 0, 4096, 1024) / 32) * 32;
  if (comfyInfo?.samplers && !comfyInfo.samplers.includes(g.sampler)) g.sampler = d.sampler;
  if (comfyInfo?.schedulers && !comfyInfo.schedulers.includes(g.scheduler)) g.scheduler = d.scheduler;
  if (!['auto', 'gpu', 'cpu', 'off'].includes(g.cacheDevice)) g.cacheDevice = 'auto';
  if (!['default', 'int8', 'int4'].includes(g.cacheDtype)) g.cacheDtype = 'default';
  g.prompt = String(g.prompt ?? '');
  g.negative = String(g.negative ?? '');
  g.editPrompt = String(g.editPrompt ?? '');
  return g;
}

function decodeImage(ref) {
  const m = /^data:image\/(png|jpe?g|webp|bmp|gif);base64,(.+)$/s.exec(ref.dataUrl || '');
  if (!m) throw new Error('Unsupported image — use PNG, JPEG, WebP, BMP or GIF');
  return { buf: Buffer.from(m[2], 'base64'), ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
}

async function loadRef(ref) {
  if (ref.dataUrl) return decodeImage(ref);
  if (ref.galleryId) {
    const m = gallery.get(ref.galleryId);
    if (!m) throw new Error('That gallery image no longer exists');
    return { buf: await fsp.readFile(gallery.filePath(m)), ext: 'png' };
  }
  if (ref.sessionId) {
    const s = session.get(ref.sessionId);
    if (!s) throw new Error('That session image is gone');
    return { buf: s.buf, ext: 'png' };
  }
  if (ref.input) {
    const abs = path.resolve(OUTPUTS, ref.input);
    if (!abs.startsWith(path.join(OUTPUTS, 'inputs'))) throw new Error('Bad input path');
    return { buf: await fsp.readFile(abs), ext: path.extname(abs).slice(1) || 'png' };
  }
  throw new Error('Missing image');
}

async function generate(body) {
  const kind = ['create', 'edit', 'upscale', 'vary'].includes(body.kind) ? body.kind : 'create';
  const incognito = !!body.incognito;
  const g = sanitize(body.settings || {});
  if (kind === 'create' && !g.prompt.trim()) throw new Error('Write a prompt first');
  if (kind === 'edit' && !g.editPrompt.trim()) throw new Error('Describe the edit first');
  if (kind === 'edit' && !(body.refs || []).length) throw new Error('Add at least one image to edit');

  if (!(comfy.reachable && comfy.wsOpen)) {
    if (!app.autoStartComfyOnGenerate) throw new Error('ComfyUI is offline — start it first');
    broadcast('toast', { kind: 'info', text: 'Starting ComfyUI first…' });
  }
  await comfy.ensureReady();

  const pack = { vae: app.models.vae, profiles: app.profiles };
  const unet = app.profiles?.[g.model]?.unet;
  const preset = matchPreset(g, { ignoreSize: kind !== 'create' });
  const tempUploads = [];
  const upload = async ({ buf, ext }) => {
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const name = incognito ? `qs_tmp_${crypto.randomBytes(6).toString('hex')}.${ext}` : `qs_${hash}.${ext}`;
    if (incognito) tempUploads.push(name);
    return comfy.upload(buf, name);
  };

  let builds = [];
  const count = kind === 'create' || kind === 'edit' ? g.batch : 1;
  const firstSeed = g.seedLocked ? g.seed : randomSeed();
  const seeds = Array.from({ length: count }, (_, i) => (g.seedLocked ? g.seed + i : i === 0 ? firstSeed : randomSeed()));
  const common = { model: g.model, unet, steps: g.steps, cfg: g.cfg, sampler: g.sampler, scheduler: g.scheduler, cacheDevice: g.cacheDevice, cacheDtype: g.cacheDtype, negative: g.negative };

  if (kind === 'create') {
    const { width, height } = resolvedSize(g);
    const est = estimateSeconds(g, settings.data.ui.calib);
    builds = seeds.map((seed) => ({
      seed, estimate: est, prompt: buildCreate({ ...g, seed }, pack).prompt,
      meta: { kind, ...common, prompt: g.prompt, transparent: g.transparent, width, height, aspect: g.aspect, megapixels: g.megapixels, customSize: g.customSize, preset, seed },
    }));
  } else if (kind === 'edit') {
    const refs = await Promise.all(body.refs.slice(0, 10).map(loadRef));
    const names = [];
    const kept = [];
    for (const r of refs) {
      names.push(await upload(r));
      if (!incognito) kept.push(await gallery.storeInput(r.buf, r.ext));
    }
    builds = seeds.map((seed) => ({
      seed, estimate: null, prompt: buildEdit({ ...g, seed }, pack, names).prompt,
      meta: { kind, ...common, editPrompt: g.editPrompt, editResolution: g.editResolution, editTransparent: g.editTransparent, refs: kept, preset, seed },
    }));
  } else {
    // upscale / vary: both re-sample an existing image (lanczos resize → VAE encode → partial denoise).
    const src = body.source || {};
    const ref = await loadRef(src);
    const info = pngInfo(ref.buf);
    if (!info) throw new Error('This needs a PNG from the gallery');
    const parent = src.galleryId ? gallery.get(src.galleryId) : session.get(src.sessionId)?.item;
    const keepAlpha = info.hasAlpha && !!parent?.hasAlpha && !!(parent?.transparent || parent?.editTransparent || parent?.keepAlpha);
    const name = await upload(ref);
    const base = { ...g, prompt: parent?.prompt || '', sampler: 'euler', scheduler: 'simple', cfg: 1, steps: 8 };
    const sourceMeta = { kind, ...common, sampler: base.sampler, scheduler: base.scheduler, cfg: 1, prompt: base.prompt, parent: parent?.id ?? null, keepAlpha };
    const estimate = (s, t) => estimateSeconds({ ...s, customSize: true, width: t.width, height: t.height }, settings.data.ui.calib) + 1;
    if (kind === 'upscale') {
      const factor = clamp(body.upscale?.factor ?? g.upscaleFactor, 1.1, 4, 2);
      const maxMp = clamp(body.upscale?.maxMp ?? g.upscaleMaxMp, 1, 16, 4);
      const target = upscaleTarget(info.width, info.height, factor, maxMp);
      const denoise = clamp(body.upscale?.denoise ?? g.upscaleDenoise, 0.05, 1, 0.35);
      const steps = Math.max(1, Math.round(8 * denoise));
      const seed = Number.isFinite(parent?.seed) ? parent.seed : firstSeed;
      const s = { ...base, seed, denoise };
      builds = [{
        seed, estimate: estimate({ ...s, steps }, target), prompt: buildUpscale(s, pack, name, target, keepAlpha).prompt,
        meta: { ...sourceMeta, steps, factor, denoise, width: target.width, height: target.height, seed },
      }];
    } else {
      const target = { width: snap(info.width), height: snap(info.height) };
      const denoise = clamp(body.vary?.denoise, 0.1, 0.95, 0.42);
      const steps = Math.max(1, Math.round(8 * denoise));
      const n = Math.round(clamp(body.vary?.count, 1, 8, 4));
      builds = Array.from({ length: n }, () => {
        const seed = randomSeed();
        const s = { ...base, seed, denoise };
        return {
          seed, estimate: estimate({ ...s, steps }, target), prompt: buildUpscale(s, pack, name, target, keepAlpha).prompt,
          meta: { ...sourceMeta, steps, denoise, varyMode: body.vary?.mode || null, width: target.width, height: target.height, seed },
        };
      });
    }
  }

  if (!incognito && ['create', 'edit'].includes(kind)) history.add(kind === 'edit' ? g.editPrompt : g.prompt, kind);

  const jobs = [];
  for (const [i, b] of builds.entries()) {
    const job = {
      kind, incognito, seed: b.seed, batchIndex: i, batchTotal: builds.length, meta: b.meta, estimate: b.estimate,
      tempUploads: i === builds.length - 1 ? tempUploads : [],
    };
    await comfy.submit(b.prompt, job);
    jobs.push(comfy.publicJob(job));
  }
  return { jobs, seed: seeds[0] };
}

// ---------- system panel ----------

let lastOllama = { online: false, models: [] };
let ollamaTick = 0;
async function systemSnapshot() {
  const [gpu, stats] = await Promise.all([sys.gpuStats(), comfy.systemStats()]);
  if (ollamaTick++ % 2 === 0) lastOllama = { ...(await ollama.ps(OLLAMA)), canStart: !!ollama.findOllamaApp() };
  const dev = stats?.devices?.[0];
  return {
    gpu,
    comfy: stats ? {
      vramTotal: dev?.vram_total, vramFree: dev?.vram_free, torchVramTotal: dev?.torch_vram_total, torchVramFree: dev?.torch_vram_free,
      ramTotal: stats.system?.ram_total, ramFree: stats.system?.ram_free, version: stats.system?.comfyui_version, pytorch: stats.system?.pytorch_version,
    } : null,
    ollama: lastOllama,
  };
}
setInterval(async () => {
  if (clients.size) broadcast('system', await systemSnapshot());
}, 2500);

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}

async function readBody(req, limit = 200 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const readJsonBody = async (req) => {
  const b = await readBody(req);
  return b.length ? JSON.parse(b.toString('utf8')) : {};
};

async function serveFile(res, file, cache) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error();
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': cache || 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

function modelFile(name, folders) {
  if (!app.comfyRoot || !name) return false;
  return folders.some((folder) => fs.existsSync(path.join(app.comfyRoot, 'ComfyUI', 'models', folder, name)));
}

function profileReady(id) {
  const p = app.profiles?.[id];
  if (!p) return false;
  return modelFile(p.unet, ['diffusion_models', 'unet']) && modelFile(p.clip, ['text_encoders', 'clip']) && modelFile(app.models.vae, ['vae']);
}

function snapshot() {
  return {
    settings: { gen: settings.data.gen, ui: settings.data.ui },
    defaults: { gen: settings.defaults.gen, ui: settings.defaults.ui },
    app: {
      port: app.port, comfyUrl: app.comfyUrl, comfyRoot: app.comfyRoot, outputDir: OUTPUTS,
      models: app.models, vram: app.vram, profiles: Object.fromEntries(Object.entries(app.profiles || {}).map(([id, p]) => [id, { ...p, ready: profileReady(id) }])),
      quitWhenWindowClosed: app.quitWhenWindowClosed, ollamaUrl: OLLAMA, enhancerSource: enhancerPrompts.source,
    },
    status: comfy.status(),
    info: comfyInfo,
    jobs: [...comfy.jobs.values()].map((j) => comfy.publicJob(j)),
    logs: comfy.logs.slice(-800),
    session: [...session.values()].map((s) => s.item).reverse(),
  };
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

route('GET', /^\/api\/ping$/, () => ({ ok: true, app: 'qwen-studio' }));
route('GET', /^\/api\/state$/, () => snapshot());

route('PUT', /^\/api\/settings$/, async (req) => {
  const b = await readJsonBody(req);
  if (b.gen) settings.update('gen', b.gen);
  if (b.ui) settings.update('ui', b.ui);
  return { ok: true };
});
route('POST', /^\/api\/settings\/reset$/, async () => {
  await settings.reset();
  return { settings: { gen: settings.data.gen, ui: settings.data.ui } };
});

route('POST', /^\/api\/comfy\/start$/, () => comfy.start());
route('POST', /^\/api\/comfy\/stop$/, async (req) => comfy.stop(await readJsonBody(req)));
route('GET', /^\/api\/comfy\/owner$/, () => comfy.portOwner());
route('POST', /^\/api\/comfy\/free$/, async () => ({ ok: await comfy.free() }));

route('POST', /^\/api\/generate$/, async (req) => generate(await readJsonBody(req)));
route('POST', /^\/api\/cancel$/, async (req) => {
  const b = await readJsonBody(req);
  if (b.all) await comfy.cancelAll();
  else await comfy.cancel(b.id);
  return { ok: true };
});

route('GET', /^\/api\/gallery$/, (req, url) => gallery.list({
  offset: +url.searchParams.get('offset') || 0,
  limit: Math.min(+url.searchParams.get('limit') || 200, 1000),
  starred: url.searchParams.get('starred') === '1',
  q: url.searchParams.get('q') || '',
}));
route('GET', /^\/api\/gallery\/([\w-]+)$/, (req, url, m) => {
  const item = gallery.get(m[1]);
  return item ? { item: gallery.publicItem(item) } : { error: 'Not found', httpStatus: 404 };
});
route('POST', /^\/api\/gallery\/([\w-]+)\/star$/, async (req, url, m) => {
  const item = await gallery.setStar(m[1], (await readJsonBody(req)).starred);
  return item ? { item } : { error: 'Not found', httpStatus: 404 };
});
route('DELETE', /^\/api\/gallery\/([\w-]+)$/, async (req, url, m) => ({ ok: await gallery.remove(m[1]) }));
route('POST', /^\/api\/gallery\/([\w-]+)\/thumb$/, async (req, url, m) => ({ thumb: await gallery.saveThumb(m[1], await readBody(req, 3_000_000)) }));

route('GET', /^\/api\/session\/(ses_\w+)$/, (req, url, m, res) => {
  const s = session.get(m[1]);
  if (!s) return { error: 'Gone', httpStatus: 404 };
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
  res.end(s.buf);
  return undefined;
});
route('DELETE', /^\/api\/session$/, () => {
  session.clear();
  return { ok: true };
});
route('DELETE', /^\/api\/session\/(ses_\w+)$/, (req, url, m) => ({ ok: session.delete(m[1]) }));
route('POST', /^\/api\/session\/(ses_\w+)\/keep$/, async (req, url, m) => {
  const s = session.get(m[1]);
  if (!s) return { error: 'That session image is gone', httpStatus: 404 };
  const { id, url: _url, incognito, createdAt, width, height, hasAlpha, ...meta } = s.item;
  const item = await gallery.add(s.buf, meta);
  session.delete(m[1]);
  return { item };
});

route('POST', /^\/api\/open$/, async (req) => {
  const b = await readJsonBody(req);
  if (b.galleryId) {
    const m = gallery.get(b.galleryId);
    if (m) sys.reveal(gallery.filePath(m));
  } else if (b.target === 'comfy') sys.reveal(app.comfyRoot, false);
  else sys.reveal(OUTPUTS, false);
  return { ok: true };
});

route('GET', /^\/api\/history$/, () => history.entries);
route('POST', /^\/api\/history\/fav$/, async (req) => {
  const b = await readJsonBody(req);
  history.setFav(b.prompt, b.fav);
  return history.entries;
});
route('DELETE', /^\/api\/history$/, async (req) => {
  history.remove((await readJsonBody(req)).prompt);
  return history.entries;
});

route('GET', /^\/api\/system$/, () => systemSnapshot());
route('POST', /^\/api\/ollama\/unload$/, async (req) => {
  const b = await readJsonBody(req);
  const ps = await ollama.ps(OLLAMA);
  const names = b.all ? ps.models.map((m) => m.name) : [b.model];
  const results = await Promise.all(names.map(async (n) => ({ model: n, ok: await ollama.unload(OLLAMA, n).catch(() => false) })));
  lastOllama = await ollama.ps(OLLAMA);
  broadcast('system', await systemSnapshot());
  return { results };
});
route('GET', /^\/api\/ollama\/models$/, async () => {
  const ps = await ollama.ps(OLLAMA);
  const canStart = !!ollama.findOllamaApp();
  if (!ps.online) return { online: false, canStart, models: [] };
  const models = (await ollama.listModels(OLLAMA)) || [];
  const loaded = ps.models.map((m) => m.name);
  const preferred = settings.data.ui.enhanceModel;
  return {
    online: true, canStart, models, loaded, source: enhancerPrompts.source,
    chosen: {
      create: ollama.pickModel(models, loaded, { preferred }),
      edit: ollama.pickModel(models, loaded, { preferred, needVision: true }),
    },
  };
});
route('POST', /^\/api\/ollama\/start$/, async () => {
  if (!ollama.startOllama()) return { error: 'Ollama is not installed in the usual place' };
  for (let i = 0; i < 40; i++) {
    if ((await ollama.ps(OLLAMA)).online) return { ok: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { error: 'Ollama did not come up within 20 s' };
});

// Streams the rewritten prompt as NDJSON: {delta} … then {done, text, model, ms, unloaded}.
route('POST', /^\/api\/enhance$/, async (req, url, m, res) => {
  const b = await readJsonBody(req);
  const kind = b.kind === 'edit' ? 'edit' : 'create';
  const text = String(b.text || '').trim();
  if (!text) return { error: kind === 'edit' ? 'Write an instruction first' : 'Write a prompt first' };
  const ps = await ollama.ps(OLLAMA);
  if (!ps.online) return { error: 'Ollama is not running', offline: true, httpStatus: 503 };
  const models = (await ollama.listModels(OLLAMA)) || [];
  const loaded = ps.models.map((x) => x.name);
  const model = ollama.pickModel(models, loaded, { preferred: b.model || settings.data.ui.enhanceModel, needVision: kind === 'edit' });
  if (!model) {
    return { error: kind === 'edit' ? 'Enhancing edits needs a vision model in Ollama (e.g. qwen2.5vl or gemma3).' : 'No chat models found in Ollama.' };
  }
  const info = models.find((x) => x.name === model);
  const wasLoaded = loaded.includes(model);
  // Leave no VRAM footprint unless the model was already resident or the user asked to keep it warm.
  const keepAlive = wasLoaded ? undefined : settings.data.ui.enhanceKeepLoaded ? '10m' : 0;
  const images = kind === 'edit' ? (b.images || []).slice(0, 4).map((d) => String(d).replace(/^data:image\/\w+;base64,/, '')) : undefined;
  const userMsg = kind === 'edit'
    ? `${images?.length ? `There ${images.length === 1 ? 'is 1 input image' : `are ${images.length} input images`} (image 1 is the one being edited). ` : ''}The user's edit instruction to rewrite is:\n${text}`
    : text;

  const ac = new AbortController();
  req.on('close', () => ac.abort());
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const t0 = Date.now();
  let out = '';
  try {
    for await (const { text: delta } of ollama.chat(OLLAMA, {
      model, system: enhancerPrompts[kind], user: userMsg, images, keepAlive, think: info?.thinking ? false : undefined, signal: ac.signal,
    })) {
      out += delta;
      res.write(`${JSON.stringify({ delta })}\n`);
    }
    res.write(`${JSON.stringify({ done: true, text: tidy(out), model, ms: Date.now() - t0, unloaded: keepAlive === 0 })}\n`);
  } catch (e) {
    if (!ac.signal.aborted) res.write(`${JSON.stringify({ error: e.message })}\n`);
  }
  res.end();
  return undefined;
});

route('POST', /^\/api\/quit$/, () => {
  setTimeout(() => shutdown('Quit from the app'), 50);
  return { ok: true };
});

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  // Only answer requests addressed to this machine, and refuse cross-site writes (same idea as ComfyUI's origin check).
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.has(host)) return send(res, 403, { error: 'Forbidden host' });
  if (req.method !== 'GET' && req.headers.origin) {
    let ok = false;
    try { ok = new URL(req.headers.origin).host === req.headers.host; } catch { /* bad origin */ }
    if (!ok) return send(res, 403, { error: 'Cross-origin request refused' });
  }

  try {
    if (url.pathname === '/api/events') return openEvents(req, res);

    for (const r of routes) {
      const m = r.method === req.method && r.pattern.exec(url.pathname);
      if (!m) continue;
      const out = await r.fn(req, url, m, res);
      if (out === undefined) return undefined;
      return send(res, out?.httpStatus || (out?.error ? 400 : 200), out);
    }

    if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
    if (url.pathname.startsWith('/outputs/')) {
      const file = path.resolve(OUTPUTS, decodeURIComponent(url.pathname.slice('/outputs/'.length)));
      if (!file.startsWith(OUTPUTS + path.sep)) return send(res, 403, { error: 'Forbidden' });
      return serveFile(res, file, 'private, max-age=31536000, immutable');
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
    return serveFile(res, file);
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
});

function openEvents(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  clearTimeout(quitTimer);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  systemSnapshot().then((s) => res.write(`event: system\ndata: ${JSON.stringify(s)}\n\n`)).catch(() => {});
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    maybeQuitSoon();
  });
}

// ---------- lifecycle ----------

let quitTimer = null;
function maybeQuitSoon() {
  if (!app.quitWhenWindowClosed || clients.size) return;
  clearTimeout(quitTimer);
  quitTimer = setTimeout(() => {
    if (clients.size) return;
    if (comfy.activeCount()) return maybeQuitSoon(); // let queued work finish first
    shutdown('App window closed');
  }, 20000);
}

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Qwen Studio] shutting down: ${reason}`);
  broadcast('bye', { reason });
  await settings.save().catch(() => {});
  if (app.stopComfyOnQuit && comfy.child) {
    comfy.sys('Stopping ComfyUI because Qwen Studio is closing.');
    await comfy.stop().catch(() => {});
  }
  for (const res of clients) res.end();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => shutdown(sig));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`[Qwen Studio] port ${app.port} is already in use — is Qwen Studio already running?`);
    process.exit(0);
  }
  throw e;
});

server.listen(app.port, '127.0.0.1', () => {
  console.log(`[Qwen Studio] http://127.0.0.1:${app.port}  ·  outputs: ${OUTPUTS}  ·  ComfyUI: ${app.comfyRoot}`);
  maybeQuitSoon();
});

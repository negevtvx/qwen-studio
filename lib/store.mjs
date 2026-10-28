// Persistence: settings (config/settings.json), prompt history, and the on-disk gallery.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { addTextChunks, parametersText, pngInfo } from './png.mjs';
import { recycle } from './sys.mjs';

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write-then-rename so a crash never leaves a half-written file.
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export class Settings {
  constructor(root) {
    this.defaultsFile = path.join(root, 'config', 'defaults.json');
    this.file = path.join(root, 'config', 'settings.json');
    this.root = root;
  }

  async load() {
    this.defaults = JSON.parse(await fsp.readFile(this.defaultsFile, 'utf8'));
    const user = await readJson(this.file, null);
    this.data = merge(this.defaults, user || {});
    if (!user) await this.save();
    return this.data;
  }

  get app() { return this.data.app; }

  resolvePath(p) { return path.isAbsolute(p) ? p : path.join(this.root, p); }

  update(section, patch) {
    if (!['gen', 'ui'].includes(section) || !isObj(patch)) return;
    this.data[section] = merge(this.data[section], patch);
    this.saveSoon();
  }

  reset() {
    this.data.gen = structuredClone(this.defaults.gen);
    const keep = { incognito: this.data.ui.incognito, calib: this.data.ui.calib };
    this.data.ui = { ...structuredClone(this.defaults.ui), ...keep };
    return this.save();
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 400);
  }

  save() {
    clearTimeout(this.timer);
    return writeJson(this.file, this.data);
  }
}

export class History {
  constructor(file) { this.file = file; this.entries = []; }

  async load() { this.entries = await readJson(this.file, []); }

  add(text, kind) {
    const prompt = (text || '').trim();
    if (!prompt) return;
    const existing = this.entries.find((e) => e.prompt === prompt);
    if (existing) {
      existing.ts = Date.now();
      existing.count = (existing.count || 1) + 1;
    } else {
      this.entries.push({ prompt, kind, ts: Date.now(), count: 1, fav: false });
    }
    this.entries.sort((a, b) => b.ts - a.ts);
    // Favorites are kept forever; everything else is capped.
    let plain = 0;
    this.entries = this.entries.filter((e) => e.fav || ++plain <= 300);
    this.save();
  }

  setFav(prompt, fav) {
    let e = this.entries.find((x) => x.prompt === prompt);
    if (!e && fav) this.entries.unshift(e = { prompt, kind: 'create', ts: Date.now(), count: 0, fav: true });
    if (e) e.fav = !!fav;
    this.save();
  }

  remove(prompt) {
    this.entries = this.entries.filter((e) => e.prompt !== prompt);
    this.save();
  }

  save() { return writeJson(this.file, this.entries).catch(() => {}); }
}

const pad = (n) => String(n).padStart(2, '0');
const SKIP_DIRS = new Set(['inputs', '.thumbs', '_trash']);

export class Gallery {
  constructor(dir) {
    this.dir = dir;
    this.items = new Map();
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    const days = await fsp.readdir(this.dir, { withFileTypes: true });
    for (const d of days) {
      if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
      const files = await fsp.readdir(path.join(this.dir, d.name));
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const meta = await readJson(path.join(this.dir, d.name, f), null);
        if (meta?.id && fs.existsSync(path.join(this.dir, d.name, meta.file))) this.items.set(meta.id, { ...meta, day: d.name });
      }
    }
  }

  publicItem(m) {
    const thumbRel = `${m.day}/.thumbs/${m.id}.webp`;
    return {
      ...m,
      url: `/outputs/${m.day}/${encodeURIComponent(m.file)}`,
      thumb: fs.existsSync(path.join(this.dir, thumbRel)) ? `/outputs/${thumbRel}` : null,
    };
  }

  list({ offset = 0, limit = 200, starred = false, q = '' } = {}) {
    const needle = q.trim().toLowerCase();
    let all = [...this.items.values()];
    if (starred) all = all.filter((m) => m.starred);
    if (needle) all = all.filter((m) => `${m.prompt || ''} ${m.editPrompt || ''} ${m.seed}`.toLowerCase().includes(needle));
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { total: all.length, items: all.slice(offset, offset + limit).map((m) => this.publicItem(m)) };
  }

  get(id) { return this.items.get(id); }

  filePath(m) { return path.join(this.dir, m.day, m.file); }

  async add(buf, meta) {
    const now = new Date();
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const stamp = `${day.replaceAll('-', '')}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const id = `qs_${stamp}_${meta.seed}_${crypto.randomBytes(2).toString('hex')}`;
    const info = pngInfo(buf) || {};
    const full = {
      ...meta, id, file: `${id}.png`, createdAt: now.toISOString(),
      width: info.width ?? meta.width, height: info.height ?? meta.height, hasAlpha: !!info.hasAlpha, starred: false,
    };
    const png = addTextChunks(buf, [['parameters', parametersText(full)], ['qwen_studio', JSON.stringify(full)]]);
    const dir = path.join(this.dir, day);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, full.file), png);
    await writeJson(path.join(dir, `${id}.json`), full);
    const stored = { ...full, day };
    this.items.set(id, stored);
    return this.publicItem(stored);
  }

  async setStar(id, starred) {
    const m = this.items.get(id);
    if (!m) return null;
    m.starred = !!starred;
    const { day, ...meta } = m;
    await writeJson(path.join(this.dir, day, `${id}.json`), meta);
    return this.publicItem(m);
  }

  async remove(id) {
    const m = this.items.get(id);
    if (!m) return false;
    const dir = path.join(this.dir, m.day);
    await recycle([path.join(dir, m.file), path.join(dir, `${id}.json`), path.join(dir, '.thumbs', `${id}.webp`)]);
    this.items.delete(id);
    return true;
  }

  async saveThumb(id, buf) {
    const m = this.items.get(id);
    if (!m || buf.length > 2_000_000) return null;
    const dir = path.join(this.dir, m.day, '.thumbs');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${id}.webp`), buf);
    return `/outputs/${m.day}/.thumbs/${id}.webp`;
  }

  // Edit reference images are kept (deduplicated by hash) so "reuse settings" can restore them.
  async storeInput(buf, ext = 'png') {
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
    const rel = `inputs/${hash}.${ext}`;
    const abs = path.join(this.dir, rel);
    if (!fs.existsSync(abs)) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
    }
    return rel;
  }
}

export { readJson, writeJson };

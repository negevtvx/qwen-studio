// Shared between the Node backend and the browser: size math, presets, timing estimates.

export const ASPECTS = [
  { id: '1:1', w: 1, h: 1 },
  { id: '4:3', w: 4, h: 3 },
  { id: '3:4', w: 3, h: 4 },
  { id: '3:2', w: 3, h: 2 },
  { id: '2:3', w: 2, h: 3 },
  { id: '16:9', w: 16, h: 9 },
  { id: '9:16', w: 9, h: 16 },
  { id: '21:9', w: 21, h: 9 },
];

// Qwen Image 2.1 is native up to 2048x2048 (4 MP). Sizes snap to multiples of 32 (template guidance).
export const MEGAPIXELS = [
  { mp: 0.5, label: '0.5' },
  { mp: 1, label: '1' },
  { mp: 1.5, label: '1.5' },
  { mp: 2, label: '2' },
  { mp: 3, label: '3' },
  { mp: 4, label: '4 · 2K' },
];

export const MIN_SIDE = 256;
export const MAX_SIDE = 4096;

export function snap(v, m = 32) {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(v / m) * m));
}

export function sizeFor(aspectId, mp) {
  const a = ASPECTS.find((x) => x.id === aspectId) || ASPECTS[0];
  const scale = Math.sqrt((mp * 1024 * 1024) / (a.w * a.h));
  return { width: snap(a.w * scale), height: snap(a.h * scale) };
}

export function resolvedSize(g) {
  return g.customSize ? { width: snap(g.width), height: snap(g.height) } : sizeFor(g.aspect, g.megapixels);
}

// Turbo is distilled for 8 Euler steps. Presets change size, and which sizes are sensible depends on the VRAM pack.
const PRESET_SIZES = {
  '12': [[0.5, 'Fast', '0.5 MP'], [1, 'Normal', 'Fits 12 GB'], [1.5, 'Quality', '1.5 MP'], [2, 'Tight', 'May spill']],
  '16': [[1, 'Fast', '1 MP'], [1.5, 'Normal', 'Fits 16 GB'], [2, 'Quality', '2 MP'], [3, 'Large', 'Tight on 16 GB']],
  '24': [[1, 'Fast', '1 MP'], [2, 'Normal', 'Recommended'], [3, 'Quality', '3 MP'], [4, '2K', 'Native 4 MP']],
};
export const PRESET_ORDER = ['fast', 'normal', 'quality', 'max'];
const PRESET_KEYS = ['model', 'megapixels', 'steps', 'cfg', 'sampler', 'scheduler'];

export function presetsFor(model) {
  const sizes = PRESET_SIZES[model] || PRESET_SIZES['12'];
  const out = {};
  sizes.forEach(([mp, label, blurb], i) => {
    out[PRESET_ORDER[i]] = { label, blurb, model: String(model), megapixels: mp, steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' };
  });
  return out;
}

// ignoreSize: edits take their canvas from the input image, so only model/steps/sampler matter.
export function matchPreset(g, { ignoreSize = false } = {}) {
  if (g.customSize && !ignoreSize) return 'custom';
  const keys = ignoreSize ? PRESET_KEYS.filter((k) => k !== 'megapixels') : PRESET_KEYS;
  const presets = presetsFor(g.model);
  for (const key of PRESET_ORDER) {
    const p = presets[key];
    if (keys.every((k) => p[k] === g[k])) return key;
  }
  return 'custom';
}

// Starting guess for it/s, copied from the int8 2.1 measurements on this 5090 Laptop.
// Real runs replace it via the calib table.
export const PERF_TABLE = {
  '12': [[0.5, 3.2], [1, 2.2], [1.5, 1.6], [2, 0.9], [3, 0.45], [4, 0.28]],
  '16': [[0.5, 3.4], [1, 2.3], [1.5, 1.7], [2, 0.95], [3, 0.5], [4, 0.3]],
  '24': [[0.5, 3.6], [1, 2.4], [1.5, 1.84], [2, 1.0], [3, 0.55], [4, 0.33]],
};
const MP_BUCKETS = [0.5, 1, 1.5, 2, 3, 4, 6, 8];

function interp(table, mp) {
  const L = Math.log;
  const x = L(Math.max(mp, 0.05));
  let i = table.findIndex(([m]) => m >= mp);
  if (i === -1) i = table.length - 1;
  if (i === 0) i = 1;
  const [x0, y0] = table[i - 1];
  const [x1, y1] = table[i];
  const t = (x - L(x0)) / (L(x1) - L(x0));
  return Math.exp(L(y0) + t * (L(y1) - L(y0)));
}

export function mpBucket(mp) {
  return MP_BUCKETS.reduce((best, b) => (Math.abs(b - mp) < Math.abs(best - mp) ? b : best));
}

export const calibKey = (model, mp) => `${model}@${mpBucket(mp)}`;

// calib: { "turbo@2": measured it/s, ... } learned from real runs in this app.
export function itsFor(model, mp, calib) {
  const table = PERF_TABLE[model] || PERF_TABLE['12'];
  const guess = interp(table, mp);
  const b = mpBucket(mp);
  const measured = calib?.[`${model}@${b}`];
  return typeof measured === 'number' && measured > 0 ? measured * (guess / interp(table, b)) : guess;
}

export function estimateSeconds(g, calib, mpOverride) {
  const { width, height } = resolvedSize(g);
  const mp = mpOverride ?? (width * height) / (1024 * 1024);
  return g.steps / itsFor(g.model, mp, calib) + 1.6 + 0.5 * mp; // + prompt encode + VAE decode
}

export function formatDuration(s) {
  if (!isFinite(s)) return '–';
  if (s < 1) return '<1 s';
  if (s < 60) return `${Math.round(s)} s`;
  const m = s / 60;
  return m < 10 ? `${m.toFixed(1)} min` : `${Math.round(m)} min`;
}

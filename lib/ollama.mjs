// Ollama integration: loaded-model panel, unload, model listing, streaming chat for the prompt enhancer.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const t = (ms) => AbortSignal.timeout(ms);
const post = (base, p, body, signal) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
});

export async function ps(base) {
  try {
    const r = await fetch(`${base}/api/ps`, { signal: t(1200) });
    if (!r.ok) return { online: true, models: [], error: `HTTP ${r.status}` };
    const j = await r.json();
    return {
      online: true,
      models: (j.models || []).map((m) => ({ name: m.name || m.model, sizeVram: m.size_vram ?? 0, size: m.size ?? 0, expiresAt: m.expires_at })),
    };
  } catch {
    return { online: false, models: [] };
  }
}

// keep_alive: 0 asks Ollama to unload immediately. Embedding models reject /api/generate, so fall back to /api/embed.
export async function unload(base, model) {
  let r = await post(base, '/api/generate', { model, keep_alive: 0 }, t(15000));
  if (!r.ok) r = await post(base, '/api/embed', { model, input: '', keep_alive: 0 }, t(15000));
  return r.ok;
}

const showCache = new Map();
async function capabilities(base, m) {
  const key = `${m.name}|${m.digest || m.modified_at || ''}`;
  if (showCache.has(key)) return showCache.get(key);
  let caps = null;
  try {
    const r = await post(base, '/api/show', { model: m.name }, t(4000));
    if (r.ok) caps = (await r.json()).capabilities || null;
  } catch { /* older Ollama */ }
  showCache.set(key, caps);
  return caps;
}

// Chat-capable models with what they can do. Embedding-only models are left out.
export async function listModels(base) {
  let tags;
  try {
    const r = await fetch(`${base}/api/tags`, { signal: t(2000) });
    tags = (await r.json()).models || [];
  } catch {
    return null;
  }
  const out = [];
  for (const m of tags) {
    const caps = await capabilities(base, m);
    const embedOnly = caps ? !caps.includes('completion') : /embed/i.test(m.name);
    if (embedOnly) continue;
    out.push({
      name: m.name, size: m.size ?? 0, params: m.details?.parameter_size || '', family: m.details?.family || '',
      vision: caps ? caps.includes('vision') : /vl|llava|vision|gemma3|minicpm-v|moondream/i.test(m.name),
      thinking: caps ? caps.includes('thinking') : false,
    });
  }
  return out;
}

// Prefer a model that's already in memory, then a mid-sized Qwen/Llama/Gemma/Mistral, then anything.
export function pickModel(models, loaded, { needVision = false, preferred } = {}) {
  const pool = models.filter((m) => !needVision || m.vision);
  if (!pool.length) return null;
  if (preferred && pool.some((m) => m.name === preferred)) return preferred;
  const inMem = pool.find((m) => loaded.includes(m.name));
  if (inMem) return inMem.name;
  const score = (m) => {
    const gbSize = m.size / 1024 ** 3;
    let s = /qwen/i.test(m.name) ? 0 : /llama|gemma|mistral|phi/i.test(m.name) ? 1 : 2;
    if (gbSize < 1.5 || gbSize > 20) s += 3; // too small to follow a long brief, or too big to share a GPU
    return s * 100 + Math.abs(gbSize - 6);
  };
  return [...pool].sort((a, b) => score(a) - score(b))[0].name;
}

// Streams { text } deltas from /api/chat. Thinking output is ignored; only the answer is streamed.
export async function* chat(base, { model, system, user, images, keepAlive, think, signal }) {
  const body = {
    model, stream: true,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user, ...(images?.length ? { images } : {}) }],
    options: { temperature: 0.7, top_p: 0.95, top_k: 20, repeat_penalty: 1.05, num_ctx: 8192 },
  };
  if (keepAlive !== undefined) body.keep_alive = keepAlive;
  if (think === false) body.think = false;
  const r = await post(base, '/api/chat', body, signal);
  if (!r.ok) {
    let msg = `Ollama returned HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* keep generic */ }
    throw new Error(msg);
  }
  const decoder = new TextDecoder();
  let buf = '';
  let inThink = false;
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      let text = j.message?.content || '';
      // Models that inline <think>…</think> despite think:false.
      if (text.includes('<think>')) { inThink = true; text = text.split('<think>')[0]; }
      if (inThink) {
        const end = text.indexOf('</think>');
        if (end < 0) continue;
        inThink = false;
        text = text.slice(end + 8);
      }
      if (text) yield { text };
      if (j.done) return;
    }
  }
}

// Ollama's own tray app starts the server with the user's settings (OLLAMA_MODELS etc.).
export function findOllamaApp() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama app.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function startOllama() {
  const exe = findOllamaApp();
  if (!exe) return false;
  spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

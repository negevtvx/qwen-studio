// ComfyUI connection: process lifecycle, websocket events, job tracking, and log capture.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NODE, PHASES } from './workflow.mjs';
import { findListeningPid, processInfo, killTree } from './sys.mjs';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const BAR = /\d+%\|/;
const MAX_LOG = 4000;
const FINAL = new Set(['done', 'error', 'cancelled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ComfyManager extends EventEmitter {
  constructor(app) {
    super();
    this.base = app.comfyUrl.replace(/\/+$/, '');
    this.port = Number(new URL(this.base).port) || 80;
    this.root = app.comfyRoot;
    this.launchScript = app.launchScript;
    this.extraArgs = app.launchExtraArgs || [];
    this.clientId = `qwen-studio-${crypto.randomUUID()}`;
    this.child = null;
    this.startedAt = null;
    this.reachable = false;
    this.ws = null;
    this.wsOpen = false;
    this.stopping = false;
    this.queueRemaining = 0;
    this.runningId = null;
    this.state = 'offline';
    this.jobs = new Map();
    this.logs = [];
    this.logSeq = 0;
    this.logBatch = new Map();
    this.partial = { out: '', err: '', ext: '' };
    this.flushTimers = {};
    this.decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
    this.lastPreviewAt = 0;
    this.info = null;
    setInterval(() => this.poll(), 1500);
    this.poll();
  }

  // ---------- status ----------

  status() {
    return {
      state: this.state, owned: !!this.child, pid: this.child?.pid ?? null,
      queueRemaining: this.queueRemaining, startedAt: this.startedAt, url: this.base,
    };
  }

  computeState() {
    let s;
    if (this.stopping) s = 'stopping';
    else if (!this.reachable || !this.wsOpen) s = this.child || this.reachable ? 'starting' : 'offline';
    else s = this.queueRemaining > 0 || this.runningId ? 'busy' : 'ready';
    const sig = `${s}|${this.queueRemaining}|${!!this.child}`;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.state = s;
      this.emit('status', this.status());
    }
  }

  // Under heavy load (bf16 at 2K, VRAM full) ComfyUI's HTTP side can answer slowly. An open websocket is
  // proof enough that it's alive, so HTTP timeouts only count as "offline" when the socket is down too.
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const r = await fetch(`${this.base}/queue`, { signal: AbortSignal.timeout(4000) });
      const q = await r.json();
      this.pollFails = 0;
      this.queueRemaining = (q.queue_running?.length || 0) + (q.queue_pending?.length || 0);
      const running = q.queue_running?.[0]?.[1];
      if (running && !this.runningId && this.jobs.has(running)) this.runningId = running;
      if (!this.reachable) {
        this.reachable = true;
        this.onReachable();
      }
    } catch {
      this.pollFails = (this.pollFails || 0) + 1;
      const socketAlive = this.wsOpen && this.ws?.readyState === WebSocket.OPEN;
      if (this.reachable && !socketAlive && this.pollFails >= 2) {
        this.reachable = false;
        this.onUnreachable();
      }
    } finally {
      this.polling = false;
      this.computeState();
    }
  }

  onReachable() {
    if (this.announced !== this.startedAt) {
      this.announced = this.startedAt;
      if (!this.child) this.sys(`Connected to a ComfyUI that was already running on port ${this.port} (not started by Qwen Studio).`);
      else this.sys(`ComfyUI is up after ${((Date.now() - this.startedAt) / 1000).toFixed(1)} s.`);
    } else {
      this.sys('Reconnected to ComfyUI.');
    }
    this.connectWs();
    this.loadInfo();
  }

  onUnreachable() {
    this.ws?.close();
    // Keep runningId while our process is alive: a hiccup must not orphan the job's final image.
    if (!this.child) {
      this.runningId = null;
      this.failActive('ComfyUI went offline');
    }
  }

  async ensureReady(timeoutMs = 180000) {
    if (this.reachable && this.wsOpen) return;
    if (!this.reachable && !this.child) {
      const r = await this.start();
      if (!r.ok) throw new Error(r.error || 'Could not start ComfyUI');
    }
    const t0 = Date.now();
    while (!(this.reachable && this.wsOpen)) {
      if (!this.child && !this.reachable) throw new Error('ComfyUI exited while starting — check the log panel');
      if (Date.now() - t0 > timeoutMs) throw new Error('Timed out waiting for ComfyUI to start');
      await sleep(400);
    }
  }

  // ---------- process ----------

  // Reuses the install's own launch script: take its python command line and append our flags
  // (no browser pop-up, live previews). Falls back to running the script as-is.
  resolveLaunch() {
    const script = path.resolve(this.root, this.launchScript);
    if (!fs.existsSync(script)) throw new Error(`Launch script not found: ${script}`);
    const text = fs.readFileSync(script, 'utf8');
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /main\.py/i.test(l) && !/^(rem\b|::)/i.test(l));
    if (line) {
      const tokens = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
      const exe = path.resolve(this.root, tokens[0]);
      if (fs.existsSync(exe)) {
        const args = tokens.slice(1);
        let group = [];
        const groups = [];
        for (const t of this.extraArgs) {
          if (t.startsWith('--') && group.length) { groups.push(group); group = []; }
          group.push(t);
        }
        if (group.length) groups.push(group);
        for (const g of groups) if (!args.includes(g[0])) args.push(...g);
        return { exe, args, script, direct: true };
      }
    }
    return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${script}"`], script, direct: false };
  }

  async start() {
    if (this.reachable) return { ok: true, already: true };
    if (this.child) return { ok: true, starting: true };
    const busyPid = await findListeningPid(this.port);
    if (busyPid) {
      const p = await processInfo(busyPid);
      return { ok: false, error: `Port ${this.port} is held by PID ${busyPid} (${p?.name || 'unknown'}) but it isn't answering like ComfyUI.` };
    }
    let l;
    try {
      l = this.resolveLaunch();
    } catch (e) {
      this.sys(e.message, 'error');
      return { ok: false, error: e.message };
    }
    const shown = [path.relative(this.root, l.exe) || l.exe, ...l.args].join(' ');
    this.sys(`Starting ComfyUI from ${path.basename(l.script)} → ${shown}`);
    const child = spawn(l.exe, l.args, {
      cwd: this.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: !l.direct,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    this.startedAt = Date.now();
    child.stdout.on('data', (d) => this.ingest('out', this.decoders.out.write(d)));
    child.stderr.on('data', (d) => this.ingest('err', this.decoders.err.write(d)));
    child.on('error', (e) => this.sys(`Failed to launch ComfyUI: ${e.message}`, 'error'));
    child.on('exit', (code) => {
      for (const k of ['out', 'err']) this.flushPartial(k);
      const expected = child.killedByUs || this.stopping;
      this.sys(`ComfyUI exited${code != null ? ` (code ${code})` : ''}.`, code && !expected ? 'error' : 'sys');
      if (this.child === child) {
        this.child = null;
        this.startedAt = null;
        this.announced = undefined;
      }
      this.failActive(expected ? 'Cancelled — ComfyUI was stopped' : 'ComfyUI exited unexpectedly');
      this.computeState();
    });
    this.computeState();
    return { ok: true, pid: child.pid };
  }

  // Owner of the port, for confirming before killing a ComfyUI we didn't start.
  async portOwner() {
    const pid = this.child?.pid ?? (await findListeningPid(this.port));
    if (!pid) return null;
    return { pid, owned: !!this.child, process: await processInfo(pid) };
  }

  async stop({ confirmPid } = {}) {
    const owned = !!this.child;
    let pid = this.child?.pid;
    if (!pid) {
      pid = await findListeningPid(this.port);
      if (!pid) return { ok: true, nothing: true };
      if (Number(confirmPid) !== pid) return { ok: false, needsConfirm: true, pid, process: await processInfo(pid) };
    }
    this.stopping = true;
    if (this.child) this.child.killedByUs = true;
    this.computeState();
    this.sys(`Stopping ComfyUI (PID ${pid}${owned ? '' : ', started outside Qwen Studio'})…`);
    const r = await killTree(pid);
    for (let i = 0; i < 40 && (await findListeningPid(this.port)); i++) await sleep(250);
    this.stopping = false;
    this.reachable = false;
    this.announced = undefined;
    this.ws?.close();
    this.runningId = null;
    this.queueRemaining = 0;
    this.failActive('Cancelled — ComfyUI was stopped');
    if (!r.ok) this.sys(`taskkill: ${r.output}`, 'error');
    this.computeState();
    return { ok: r.ok, pid };
  }

  // ---------- websocket ----------

  connectWs() {
    if (this.ws) return;
    const ws = new WebSocket(`${this.base.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.wsOpen = true;
      this.computeState();
      if (!this.child) this.subscribeLogs();
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.wsOpen = false;
      this.computeState();
      if (this.reachable) setTimeout(() => this.reachable && this.connectWs(), 1000);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => this.onWs(ev.data);
  }

  // For a ComfyUI we didn't launch we can't read stdout, so use its log subscription instead.
  async subscribeLogs() {
    try {
      const raw = await (await fetch(`${this.base}/internal/logs/raw`)).json();
      this.sys('— ComfyUI log history —');
      for (const e of raw.entries || []) this.ingest('ext', e.m);
      await this.post('/internal/logs/subscribe', { clientId: this.clientId, enabled: true });
    } catch { /* older ComfyUI */ }
  }

  onWs(data) {
    if (typeof data !== 'string') return this.onBinary(Buffer.from(data));
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const d = msg.data || {};
    const job = d.prompt_id ? this.jobs.get(d.prompt_id) : null;
    // Self-heal the running pointer from any in-flight event for one of our jobs.
    if (job && !FINAL.has(job.status) && (msg.type === 'progress' || (msg.type === 'executing' && d.node != null))) {
      this.runningId = d.prompt_id;
      if (job.status === 'queued') {
        job.status = 'running';
        job.startedAt = job.startedAt || Date.now();
      }
    }
    switch (msg.type) {
      case 'status': {
        const qr = d.status?.exec_info?.queue_remaining;
        if (typeof qr === 'number') this.queueRemaining = qr;
        this.computeState();
        break;
      }
      case 'logs':
        for (const e of d.entries || []) this.ingest('ext', e.m);
        break;
      case 'execution_start':
        this.runningId = d.prompt_id;
        if (job) {
          job.status = 'running';
          job.startedAt = Date.now();
          this.emitJob(job);
        }
        this.computeState();
        break;
      case 'executing':
        if (d.node == null) {
          if (this.runningId === d.prompt_id) this.runningId = null;
          if (job) this.finish(job, 'done');
          this.computeState();
        } else if (job) {
          job.node = String(d.node);
          job.phase = PHASES[job.node] || 'Working';
          this.emitJob(job);
        }
        break;
      case 'progress': {
        if (!job) break;
        const now = Date.now();
        const node = String(d.node ?? job.node);
        if (node === NODE.sampler) {
          // Rate from the first observed step onward; the first step includes model warm-up, so wait for 2+ steps.
          if (!job.sampleFirst || d.value < job.sampleFirstValue) {
            job.sampleFirst = now;
            job.sampleFirstValue = d.value;
          }
          const done = d.value - job.sampleFirstValue;
          if (done >= 2) job.itps = done / Math.max(0.001, (now - job.sampleFirst) / 1000);
          job.step = d.value;
          job.steps = d.max;
        }
        this.emit('progress', { id: job.id, value: d.value, max: d.max, node, itps: job.itps ?? null });
        break;
      }
      case 'execution_success':
        if (this.runningId === d.prompt_id) this.runningId = null;
        if (job) this.finish(job, 'done');
        this.computeState();
        break;
      case 'execution_error':
        if (this.runningId === d.prompt_id) this.runningId = null;
        this.sys(`Generation failed in ${d.node_type}: ${d.exception_type}: ${d.exception_message}`, 'error');
        if (job) {
          job.error = `${d.exception_message || d.exception_type} (${d.node_type})`;
          this.finish(job, 'error');
        }
        this.computeState();
        break;
      case 'execution_interrupted':
        if (this.runningId === d.prompt_id) this.runningId = null;
        if (job) this.finish(job, 'cancelled');
        this.computeState();
        break;
      default:
        break;
    }
  }

  // Binary frames: [u32 type][u32 format][image bytes]. Type 1 = preview image (1 JPEG, 2 PNG).
  // Full-size results come from the SaveImageWebsocket node as PNG frames while it is executing.
  onBinary(buf) {
    const type = buf.readUInt32BE(0);
    let fmt, img;
    if (type === 1) {
      fmt = buf.readUInt32BE(4) === 2 ? 'png' : 'jpeg';
      img = buf.subarray(8);
    } else if (type === 4) {
      const len = buf.readUInt32BE(4);
      let meta = {};
      try { meta = JSON.parse(buf.subarray(8, 8 + len).toString()); } catch { /* ignore */ }
      fmt = /png/i.test(meta.image_type || '') ? 'png' : 'jpeg';
      img = buf.subarray(8 + len);
    } else return;
    let job = this.runningId ? this.jobs.get(this.runningId) : null;
    if (!job) {
      const running = [...this.jobs.values()].filter((j) => j.status === 'running');
      if (running.length === 1) [job] = running;
    }
    if (job && job.node === NODE.save && fmt === 'png') {
      this.emit('image', { job, buf: Buffer.from(img) });
      return;
    }
    const now = Date.now();
    if (!job || now - this.lastPreviewAt < 110) return;
    this.lastPreviewAt = now;
    this.emit('preview', { id: job.id, src: `data:image/${fmt};base64,${img.toString('base64')}` });
  }

  // ---------- jobs ----------

  async post(p, body) {
    const r = await fetch(`${this.base}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    return r;
  }

  async submit(prompt, job) {
    const r = await this.post('/prompt', { prompt, client_id: this.clientId });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.error) throw new Error(describeRejection(body) || `ComfyUI rejected the job (HTTP ${r.status})`);
    job.id = body.prompt_id;
    job.status = 'queued';
    job.queuedAt = Date.now();
    this.jobs.set(job.id, job);
    this.prune();
    this.emitJob(job);
    return job;
  }

  async upload(buf, name) {
    const fd = new FormData();
    fd.append('image', new Blob([buf]), name);
    fd.append('subfolder', 'qwenstudio');
    fd.append('type', 'input');
    fd.append('overwrite', 'true');
    const r = await fetch(`${this.base}/upload/image`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`Image upload to ComfyUI failed (HTTP ${r.status})`);
    const j = await r.json();
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job || FINAL.has(job.status)) return;
    if (this.runningId === id || job.status === 'running') {
      await this.post('/interrupt', { prompt_id: id });
    } else {
      await this.post('/queue', { delete: [id] });
      this.finish(job, 'cancelled');
    }
  }

  async cancelAll() {
    const active = [...this.jobs.values()].filter((j) => !FINAL.has(j.status));
    const queued = active.filter((j) => j.id !== this.runningId && j.status === 'queued');
    if (queued.length) {
      await this.post('/queue', { delete: queued.map((j) => j.id) });
      queued.forEach((j) => this.finish(j, 'cancelled'));
    }
    const running = active.find((j) => j.id === this.runningId || j.status === 'running');
    if (running) await this.post('/interrupt', { prompt_id: running.id });
  }

  finish(job, status) {
    if (FINAL.has(job.status)) return;
    job.status = status;
    job.endedAt = Date.now();
    this.emitJob(job);
    this.emit('finished', job);
  }

  failActive(reason) {
    for (const job of this.jobs.values()) {
      if (FINAL.has(job.status)) continue;
      job.error = reason;
      this.finish(job, reason.startsWith('Cancelled') ? 'cancelled' : 'error');
    }
  }

  activeCount() {
    return [...this.jobs.values()].filter((j) => !FINAL.has(j.status)).length;
  }

  prune() {
    const done = [...this.jobs.values()].filter((j) => FINAL.has(j.status));
    for (const j of done.slice(0, Math.max(0, done.length - 60))) this.jobs.delete(j.id);
  }

  publicJob(j) {
    return {
      id: j.id, kind: j.kind, status: j.status, phase: j.phase ?? null, node: j.node ?? null,
      step: j.step ?? null, steps: j.steps ?? j.meta?.steps ?? null, itps: j.itps ?? null, error: j.error ?? null,
      seed: j.seed, batchIndex: j.batchIndex, batchTotal: j.batchTotal, incognito: j.incognito,
      queuedAt: j.queuedAt, startedAt: j.startedAt ?? null, endedAt: j.endedAt ?? null, estimate: j.estimate ?? null,
      label: (j.meta?.editPrompt || j.meta?.prompt || '').slice(0, 140), model: j.meta?.model,
      width: j.meta?.width ?? null, height: j.meta?.height ?? null,
    };
  }

  emitJob(j) { this.emit('job', this.publicJob(j)); }

  // ---------- misc API ----------

  async loadInfo() {
    try {
      const get = async (n) => (await (await fetch(`${this.base}/object_info/${n}`)).json())[n].input.required;
      const ks = await get('KSampler');
      const unet = await get('UNETLoader');
      const unetGguf = await get('UnetLoaderGGUF').catch(() => null);
      const clip = await get('CLIPLoader');
      const gguf = await get('CLIPLoaderGGUF').catch(() => null);
      const vae = await get('VAELoader');
      const clips = [...new Set([...(clip?.clip_name?.[0] || []), ...(gguf?.clip_name?.[0] || [])])];
      const unets = [...new Set([...(unet?.unet_name?.[0] || []), ...(unetGguf?.unet_name?.[0] || [])])];
      this.info = {
        samplers: ks.sampler_name[0], schedulers: ks.scheduler[0],
        unets, clips, vaes: vae.vae_name[0],
        gguf: !!gguf,
      };
      this.emit('info', this.info);
    } catch (e) {
      this.sys(`Could not read /object_info: ${e.message}`, 'warn');
    }
  }

  async systemStats() {
    if (!this.reachable) return null;
    try {
      return await (await fetch(`${this.base}/system_stats`, { signal: AbortSignal.timeout(1500) })).json();
    } catch {
      return null;
    }
  }

  async free() {
    const r = await this.post('/free', { unload_models: true, free_memory: true });
    this.sys('Asked ComfyUI to unload models and free VRAM.');
    return r.ok;
  }

  async forgetHistory(id) {
    try { await this.post('/history', { delete: [id] }); } catch { /* best effort */ }
  }

  // ---------- logs ----------

  sys(text, level = 'sys') {
    this.pushLine(`[Qwen Studio] ${text}`, false, level);
  }

  ingest(stream, text) {
    if (!text) return;
    // A pending tqdm bar followed by a normal log line (not a "\r" redraw) is its own line.
    if (this.partial[stream] && BAR.test(this.partial[stream]) && !text.startsWith('\r')) {
      this.pushLine(this.partial[stream], true);
      this.partial[stream] = '';
    }
    const buf = this.partial[stream] + text;
    const re = /\r\n|\n|\r/g;
    let m, last = 0;
    while ((m = re.exec(buf))) {
      if (m[0] === '\r' && m.index === buf.length - 1) break; // may be half of \r\n
      this.pushLine(buf.slice(last, m.index), m[0] === '\r');
      last = re.lastIndex;
    }
    this.partial[stream] = buf.slice(last);
    // tqdm bars never end with a newline until they finish; show the pending one shortly.
    clearTimeout(this.flushTimers[stream]);
    if (this.partial[stream]) this.flushTimers[stream] = setTimeout(() => this.flushPartial(stream, true), 250);
  }

  flushPartial(stream, transient = false) {
    const p = this.partial[stream].replace(/\r$/, '');
    this.partial[stream] = '';
    if (p) this.pushLine(p, transient);
  }

  pushLine(raw, transient, forced) {
    const text = raw.replace(ANSI, '').replace(/\s+$/, '');
    if (!text.trim()) return;
    const bar = BAR.test(text);
    // Trust ComfyUI's own level prefix; only guess for unprefixed lines (tracebacks, raw prints).
    const prefix = /^\[(ERROR|CRITICAL|WARNING|INFO|DEBUG)\]/.exec(text)?.[1];
    const level = forced || (bar ? 'info'
      : prefix ? ({ ERROR: 'error', CRITICAL: 'error', WARNING: 'warn' }[prefix] || 'info')
        : /traceback|error|exception|out of memory|\bfailed\b/i.test(text) ? 'error'
          : /warn/i.test(text) ? 'warn' : 'info');
    const prev = this.logs[this.logs.length - 1];
    if (prev && prev.transient && (transient || bar)) {
      Object.assign(prev, { text, level, transient, t: Date.now() });
      this.queueLog(prev);
      return;
    }
    const line = { id: ++this.logSeq, t: Date.now(), text, level, transient };
    this.logs.push(line);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
    this.queueLog(line);
  }

  queueLog(line) {
    this.logBatch.set(line.id, { ...line });
    if (!this.logTimer) {
      this.logTimer = setTimeout(() => {
        this.logTimer = null;
        const lines = [...this.logBatch.values()];
        this.logBatch.clear();
        this.emit('logs', lines);
      }, 150);
    }
  }
}

function describeRejection(body) {
  if (!body) return '';
  const parts = [];
  if (body.error?.message) parts.push(body.error.message + (body.error.details ? `: ${body.error.details}` : ''));
  for (const [id, ne] of Object.entries(body.node_errors || {})) {
    for (const e of ne.errors || []) parts.push(`${ne.class_type} #${id}: ${e.message}${e.details ? ` (${e.details})` : ''}`);
  }
  return parts.join(' · ');
}

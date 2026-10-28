// VRAM guard: if Ollama is holding enough GPU memory that a run would spill into system RAM,
// offer to unload it first (or do it automatically, per the user's choice).
import { $, esc, api, toast, choiceModal } from '/util.js';

// Rough peak GPU use by VRAM pack. These are conservative guesses so the guard speaks up before a spill.
export function needGb(model, mp, extraRefs = 0) {
  const base = model === '24'
    ? (mp <= 1.5 ? 15 : mp <= 2 ? 17.5 : mp <= 3 ? 19.5 : 22)
    : model === '16'
      ? (mp <= 1 ? 11 : mp <= 1.5 ? 12.5 : mp <= 2 ? 14.5 : 18)
      : (mp <= 1 ? 9.5 : mp <= 1.5 ? 11 : mp <= 2 ? 13 : 16);
  return Math.round((base + 0.4 * extraRefs) * 10) / 10;
}

async function unloadOllama() {
  const r = await api('POST', '/api/ollama/unload', { all: true });
  const ok = r.results.filter((x) => x.ok).map((x) => x.model);
  if (ok.length) toast(`Unloaded ${ok.join(', ')} from Ollama`, 'ok', 2500);
  return ok.length === r.results.length;
}

// Resolves true to go ahead, false to cancel.
export async function ensureRoom({ state, setUi }, need) {
  const gpu = state.system?.gpu;
  const loaded = state.system?.ollama?.models || [];
  if (!gpu || !loaded.length) return true;
  const ollamaGb = loaded.reduce((s, m) => s + (m.sizeVram || 0), 0) / 1024 ** 3;
  const totalGb = gpu.totalMB / 1024;
  if (ollamaGb < 0.3 || need + ollamaGb + 1.2 <= totalGb) return true;

  const mode = state.ui.vramGuard || 'ask';
  if (mode === 'off') return true;
  if (mode === 'auto') {
    await unloadOllama().catch((e) => toast(e.message, 'error'));
    return true;
  }
  const names = loaded.map((m) => m.name).join(', ');
  const choice = await choiceModal(
    'Free up GPU memory?',
    `Ollama is holding <b>${ollamaGb.toFixed(1)} GB</b> (${esc(names)}). This run needs about <b>${need} GB</b> of your ${Math.round(totalGb)} GB, so part of it would spill into system RAM and run much slower.`,
    [
      { label: 'Cancel', kind: 'ghost', value: 'cancel' },
      { label: 'Generate anyway', kind: 'ghost', value: 'anyway' },
      { label: 'Unload Ollama & generate', kind: 'accent', value: 'unload', primary: true },
    ],
    '<label class="switch" style="margin:0 0 4px"><input type="checkbox" id="guardAuto"><span class="track"></span><span>Always do this automatically</span></label>',
  );
  if (choice === 'unload') {
    if ($('#guardAuto')?.checked) setUi({ vramGuard: 'auto' });
    await unloadOllama().catch((e) => toast(e.message, 'error'));
    return true;
  }
  return choice === 'anyway';
}

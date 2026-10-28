// Before/after slider over the stage: drag (or ← →) to wipe between two images.
import { $, esc, icon } from '/util.js';

let el = null;
let pos = 50;

export const isOpen = () => !!el;

function apply() {
  if (!el) return;
  $('.cmp-after', el).style.clipPath = `inset(0 0 0 ${pos}%)`;
  $('.cmp-handle', el).style.left = `${pos}%`;
}

function fit() {
  if (!el) return;
  const a = $('.cmp-after', el);
  const box = $('.cmp-box', el);
  const canvas = $('#canvas');
  if (!a.naturalWidth) return;
  const k = Math.min((canvas.clientWidth - 12) / a.naturalWidth, (canvas.clientHeight - 12) / a.naturalHeight);
  box.style.width = `${Math.round(a.naturalWidth * k)}px`;
  box.style.height = `${Math.round(a.naturalHeight * k)}px`;
}

export function open({ before, after, beforeLabel = 'Before', afterLabel = 'After', alpha = false }) {
  close();
  pos = 50;
  el = document.createElement('div');
  el.className = 'compare';
  el.innerHTML = `
    <div class="cmp-box ${alpha ? 'alpha' : ''}">
      <img class="cmp-before" alt="" draggable="false"><img class="cmp-after" alt="" draggable="false">
      <div class="cmp-handle"><span>${icon('left')}${icon('right')}</span></div>
      <span class="cmp-label l">${esc(beforeLabel)}</span><span class="cmp-label r">${esc(afterLabel)}</span>
    </div>
    <button class="icon-btn cmp-close" title="Close compare (Esc)">${icon('x')}</button>`;
  $('#canvas').append(el);
  const box = $('.cmp-box', el);
  const afterImg = $('.cmp-after', el);
  afterImg.onload = fit;
  $('.cmp-before', el).src = before;
  afterImg.src = after;
  const move = (e) => {
    const r = box.getBoundingClientRect();
    pos = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    apply();
  };
  box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); move(e); });
  box.addEventListener('pointermove', (e) => { if (box.hasPointerCapture(e.pointerId)) move(e); });
  $('.cmp-close', el).addEventListener('click', close);
  window.addEventListener('resize', fit);
  apply();
}

export function nudge(delta) {
  pos = Math.min(100, Math.max(0, pos + delta));
  apply();
}

export function close() {
  if (!el) return;
  window.removeEventListener('resize', fit);
  el.remove();
  el = null;
}

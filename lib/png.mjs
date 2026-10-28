// Minimal PNG helpers: read size/alpha from IHDR and embed UTF-8 text (iTXt) chunks.
import zlib from 'node:zlib';

export function pngInfo(buf) {
  if (buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const colorType = buf[25];
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), hasAlpha: colorType === 4 || colorType === 6 };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

// entries: [[keyword, text], ...]; inserted right after IHDR so readers find them early.
export function addTextChunks(buf, entries) {
  if (!pngInfo(buf)) return buf;
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const chunks = entries.map(([k, v]) =>
    chunk('iTXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(String(v), 'utf8')])));
  return Buffer.concat([buf.subarray(0, ihdrEnd), ...chunks, buf.subarray(ihdrEnd)]);
}

// Human-readable settings line in the widely supported "parameters" format.
export function parametersText(m) {
  const lines = [m.kind === 'edit' ? m.editPrompt : m.prompt];
  if (m.negative) lines.push(`Negative prompt: ${m.negative}`);
  lines.push([
    `Steps: ${m.steps}`, `Sampler: ${m.sampler}`, `Schedule type: ${m.scheduler}`, `CFG scale: ${m.cfg}`,
    `Seed: ${m.seed}`, `Size: ${m.width}x${m.height}`, `Model: ${m.unet}`,
    m.denoise != null && m.denoise < 1 ? `Denoising strength: ${m.denoise}` : null,
    `Workflow: Qwen Studio ${m.kind}`,
  ].filter(Boolean).join(', '));
  return lines.join('\n');
}

// Builds ComfyUI API-format prompts for Qwen Image 2.1 Turbo.
// Denoiser: the int8 Turbo checkpoint (UNETLoader). Text encoder: AtomicChat's
// uncensored Qwen3-VL GGUF (CLIPLoaderGGUF + mmproj). At 8 Euler steps the graph
// uses Turbo's distilled sigma list; any other step count falls back to KSampler.
import { resolvedSize, snap } from '../public/shared.mjs';

// sample_sigmas from the Turbo checkpoint, plus the final 0. Shift is 1, so these are used as-is.
export const TURBO_SIGMAS = '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0';

export const NODE = {
  unet: '1', cache: '2', clip: '3', vae: '4', encode: '5', latent: '6',
  sampler: '7', decode: '8', save: '9', split: '10',
  sigmas: '12', select: '13', denoiseSplit: '14',
};

export const PHASES = {
  1: 'Loading diffusion model', 2: 'Preparing KV cache', 3: 'Loading text encoder', 4: 'Loading VAE',
  5: 'Encoding prompt', 6: 'Preparing canvas', 7: 'Sampling', 8: 'Decoding', 9: 'Finishing', 10: 'Finishing',
  12: 'Preparing schedule', 13: 'Preparing schedule', 14: 'Preparing schedule',
  20: 'Loading image', 21: 'Upscaling', 22: 'Encoding image',
};

export const TRANSPARENT_PREFIX = 'This is an RGBA format image with transparency.';
export const TRANSPARENT_SUFFIX = 'The image has an alpha channel and a transparent background.';

export function wrapTransparent(prompt) {
  const p = prompt.trim().replace(/\.?\s*$/, '.');
  return `${TRANSPARENT_PREFIX} ${p} ${TRANSPARENT_SUFFIX}`;
}

function profileOf(s, pack) {
  const p = pack.profiles?.[s.model];
  if (!p?.unet || !p?.clip) throw new Error(`No ${s.model} GB model pack is configured`);
  return p;
}

function core(s, pack) {
  const p = profileOf(s, pack);
  const ggufUnet = p.unet.toLowerCase().endsWith('.gguf');
  const ggufClip = p.clip.toLowerCase().endsWith('.gguf');
  return {
    [NODE.unet]: ggufUnet
      ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: p.unet } }
      : { class_type: 'UNETLoader', inputs: { unet_name: p.unet, weight_dtype: 'default' } },
    [NODE.cache]: { class_type: 'QwenImage21Cache', inputs: { model: [NODE.unet, 0], device: s.cacheDevice || p.cacheDevice || 'auto', dtype: s.cacheDtype || p.cacheDtype || 'default' } },
    [NODE.clip]: ggufClip
      ? { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: p.clip, type: 'qwen_image' } }
      : { class_type: 'CLIPLoader', inputs: { clip_name: p.clip, type: 'qwen_image', device: 'default' } },
    [NODE.vae]: { class_type: 'VAELoader', inputs: { vae_name: pack.vae } },
  };
}

// Distilled Turbo schedule. Other step counts or samplers use a normal KSampler.
function distilled(s) {
  return s.steps === 8 && s.sampler === 'euler';
}

function sampler(wf, s, latent, denoise = 1) {
  if (!distilled(s)) {
    wf[NODE.sampler] = {
      class_type: 'KSampler',
      inputs: {
        model: [NODE.cache, 0], positive: [NODE.encode, 0], negative: [NODE.encode, 1], latent_image: latent,
        seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise,
      },
    };
    return;
  }
  wf[NODE.sigmas] = { class_type: 'ManualSigmas', inputs: { sigmas: TURBO_SIGMAS } };
  wf[NODE.select] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
  let sigmas = [NODE.sigmas, 0];
  if (denoise < 0.999) {
    wf[NODE.denoiseSplit] = { class_type: 'SplitSigmasDenoise', inputs: { sigmas, denoise } };
    sigmas = [NODE.denoiseSplit, 1];
  }
  wf[NODE.sampler] = {
    class_type: 'SamplerCustom',
    inputs: {
      model: [NODE.cache, 0], add_noise: true, noise_seed: s.seed, cfg: s.cfg,
      positive: [NODE.encode, 0], negative: [NODE.encode, 1],
      sampler: [NODE.select, 0], sigmas, latent_image: latent,
    },
  };
}

// The Qwen 2.1 VAE always decodes RGBA. Opaque output goes through SplitImageWithAlpha to drop alpha.
function output(wf, keepAlpha, alphaFrom) {
  wf[NODE.decode] = { class_type: 'VAEDecode', inputs: { samples: [NODE.sampler, 0], vae: [NODE.vae, 0] } };
  if (alphaFrom) {
    wf[NODE.split] = { class_type: 'SplitImageWithAlpha', inputs: { image: [NODE.decode, 0] } };
    wf['11'] = { class_type: 'JoinImageWithAlpha', inputs: { image: [NODE.split, 0], alpha: alphaFrom } };
    wf[NODE.save] = { class_type: 'SaveImageWebsocket', inputs: { images: ['11', 0] } };
  } else if (keepAlpha) {
    wf[NODE.save] = { class_type: 'SaveImageWebsocket', inputs: { images: [NODE.decode, 0] } };
  } else {
    wf[NODE.split] = { class_type: 'SplitImageWithAlpha', inputs: { image: [NODE.decode, 0] } };
    wf[NODE.save] = { class_type: 'SaveImageWebsocket', inputs: { images: [NODE.split, 0] } };
  }
  return wf;
}

// Text to image.
export function buildCreate(s, models) {
  const { width, height } = resolvedSize(s);
  const wf = core(s, models);
  const prompt = s.transparent ? wrapTransparent(s.prompt) : s.prompt;
  wf[NODE.encode] = { class_type: 'TextEncodeQwenImage21', inputs: { clip: [NODE.clip, 0], prompt, negative_prompt: s.negative || '', resolution: 1024 } };
  wf[NODE.latent] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  sampler(wf, s, [NODE.latent, 0]);
  return { prompt: output(wf, !!s.transparent), width, height };
}

// Image edit: image_1 is the edit target, the rest are references (<image2>, <image3>, ...).
// The encoder's latent output sizes the canvas from image_1 (template default, "custom_size off").
export function buildEdit(s, models, refNames) {
  const wf = core(s, models);
  const enc = {
    clip: [NODE.clip, 0], vae: [NODE.vae, 0], prompt: s.editPrompt, negative_prompt: s.negative || '',
    resolution: s.editResolution ?? 1024,
  };
  refNames.forEach((name, i) => {
    const id = String(30 + i);
    wf[id] = { class_type: 'LoadImage', inputs: { image: name } };
    enc[`images.image_${i + 1}`] = [id, 0];
  });
  wf[NODE.encode] = { class_type: 'TextEncodeQwenImage21', inputs: enc };
  sampler(wf, s, [NODE.encode, 2]);
  return { prompt: output(wf, !!s.editTransparent) };
}

// Hi-res refine: lanczos upscale, VAE encode, partial re-sample with the original prompt.
// Transparent sources keep their (upscaled) alpha mask.
export function buildUpscale(s, models, srcName, target, keepAlpha) {
  const wf = core(s, models);
  wf['20'] = { class_type: 'LoadImage', inputs: { image: srcName } };
  wf['21'] = { class_type: 'ImageScale', inputs: { image: ['20', 0], upscale_method: 'lanczos', width: target.width, height: target.height, crop: 'disabled' } };
  wf['22'] = { class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: [NODE.vae, 0] } };
  wf[NODE.encode] = { class_type: 'TextEncodeQwenImage21', inputs: { clip: [NODE.clip, 0], prompt: s.prompt || 'high quality, sharp, detailed', negative_prompt: '', resolution: 1024 } };
  sampler(wf, s, ['22', 0], s.denoise);
  // LoadImage's MASK is (1 - alpha); JoinImageWithAlpha inverts it back and resizes it to the image.
  return { prompt: output(wf, false, keepAlpha ? ['20', 1] : null) };
}

export function upscaleTarget(width, height, factor, maxMp) {
  let w = width * factor, h = height * factor;
  const mp = (w * h) / (1024 * 1024);
  if (maxMp && mp > maxMp) {
    const k = Math.sqrt(maxMp / mp);
    w *= k; h *= k;
  }
  return { width: snap(w), height: snap(h) };
}

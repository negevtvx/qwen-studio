// Prompt-enhancer instructions. Read from the official Qwen Image 2.1 templates bundled with ComfyUI so they
// stay in sync with ComfyUI updates; a short built-in brief is the fallback.
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATE_DIR = ['python_embeded', 'Lib', 'site-packages', 'comfyui_workflow_templates_json', 'templates'];

function fromTemplate(file) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const g of [wf, ...(wf.definitions?.subgraphs || [])]) {
    const n = (g.nodes || []).find((x) => x.type === 'PrimitiveStringMultiline' && /system prompt/i.test(x.title || ''));
    if (n?.widgets_values?.[0]) return n.widgets_values[0];
  }
  return null;
}

// Strip the chat-template tokens the ComfyUI node embeds (<|im_start|>system … <|im_end|>).
const clean = (s) => s.replace(/^\s*<\|im_start\|>system\s*/, '').replace(/<\|im_end\|>[\s\S]*$/, '').trim();

const FALLBACK_CREATE = `You rewrite a user's image request into one long English paragraph that describes the finished image as if you were looking at it. Keep everything the user fixed (text in quotes character for character, counts, colours, positions) and decide everything they left open: subject, setting, composition, camera or medium, lighting, colour palette, materials and small concrete details. Name colours with modifiers, give materials, enumerate instead of summarising, keep physics coherent. Any text that must appear in the image stays in its own script inside double quotes. Output only the paragraph on a single line: no preamble, no labels, no markdown, no quotes around it, no aspect ratio or resolution.`;

const FALLBACK_EDIT = `You rewrite a user's image-edit instruction into a precise, complete edit instruction for an image model that sees the same input images (image 1 is edited; others are references). Describe exactly what changes, where, and how it should look, and state what must stay the same. Put any text that should be rendered in the image inside double quotes. Output only the instruction itself: no preamble, no labels, no markdown, no resolution or aspect ratio.`;

export function loadEnhancerPrompts(comfyRoot) {
  const dir = path.join(comfyRoot, ...TEMPLATE_DIR);
  const read = (name) => {
    try { return clean(fromTemplate(path.join(dir, name)) || ''); } catch { return ''; }
  };
  const create = read('image_qwen_image_2_1_t2i.json');
  const edit = read('image_qwen_image_2_1_image_edit.json').replace(/The user's edit instruction to rewrite is:\s*$/i, '').trim();
  return {
    create: create || FALLBACK_CREATE,
    edit: edit || FALLBACK_EDIT,
    source: create ? 'official Qwen Image 2.1 template' : 'built-in brief',
  };
}

// Tidy a model's answer into a single prompt paragraph.
export function tidy(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*(here is|here's|sure|okay|certainly)[^\n:]*:\s*/i, '')
    .replace(/^```[a-z]*\s*|\s*```$/g, '')
    .replace(/^\s*["“](.*)["”]\s*$/s, '$1')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

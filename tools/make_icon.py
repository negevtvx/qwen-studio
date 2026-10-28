# Renders public/icon.ico (multi-size) to match public/icon.svg.
# Run with any Python that has Pillow, e.g. ComfyUI's embedded one:
#   <ComfyUI>\python_embeded\python.exe -s -B tools\make_icon.py
import os
from PIL import Image, ImageDraw

S = 1024
here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, '..', 'public', 'icon.ico')

stops = [(0.0, (184, 255, 240)), (0.55, (26, 168, 138)), (1.0, (12, 92, 80))]
def grad(t):
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if t <= b:
            k = (t - a) / (b - a)
            return tuple(round(ca[i] + (cb[i] - ca[i]) * k) for i in range(3))
    return stops[-1][1]

bg = Image.new('RGB', (S, S))
px = bg.load()
for y in range(S):
    for x in range(S):
        px[x, y] = grad((x + y) / (2 * S))

mask = Image.new('L', (S, S), 0)
m = S / 64
ImageDraw.Draw(mask).rounded_rectangle([2 * m, 2 * m, 62 * m, 62 * m], radius=16 * m, fill=255)
icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
icon.paste(bg, (0, 0), mask)

d = ImageDraw.Draw(icon)
ink = (14, 15, 19, 255)
cx = cy = 30 * m
r, w = 14 * m, 6.5 * m
d.ellipse([cx - r - w / 2, cy - r - w / 2, cx + r + w / 2, cy + r + w / 2], outline=ink, width=round(w))
d.line([37 * m, 37 * m, 48 * m, 48 * m], fill=ink, width=round(7 * m))
for px_, py_ in ((37 * m, 37 * m), (48 * m, 48 * m)):
    d.ellipse([px_ - 3.5 * m, py_ - 3.5 * m, px_ + 3.5 * m, py_ + 3.5 * m], fill=ink)
d.ellipse([cx - 4.2 * m, cy - 4.2 * m, cx + 4.2 * m, cy + 4.2 * m], fill=ink)

sizes = [256, 128, 64, 48, 32, 24, 16]
icon.resize((256, 256), Image.LANCZOS).save(out, sizes=[(s, s) for s in sizes])
print('wrote', os.path.normpath(out))

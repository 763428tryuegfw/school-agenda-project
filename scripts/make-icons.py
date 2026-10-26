"""Gera os ícones do app a partir de assets-src/logo-original.png (Pillow)."""
from PIL import Image, ImageDraw, ImageFilter
import numpy as np, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = Image.open(os.path.join(ROOT, 'assets-src', 'logo-original.png')).convert('RGB')
BG = (251, 252, 253)
a = np.array(src).astype(int)
mn, mx = a.min(axis=2), a.max(axis=2)
# fundo quadriculado e brancos -> uma cor única (some a grade da captura)
clear = (mn >= 232) & ((mx - mn) < 14)
a[clear] = BG
img = Image.fromarray(a.astype('uint8'))
ys, xs = np.where(~clear)
box = (xs.min() - 2, ys.min() - 2, xs.max() + 3, ys.max() + 3)
logo = img.crop(box)

def tile(size, frac, rounded):
    big = size * 4
    canvas = Image.new('RGB', (big, big), BG)
    side = int(big * frac)
    w, h = logo.size
    k = side / max(w, h)
    lg = logo.resize((int(w * k), int(h * k)), Image.LANCZOS)
    canvas.paste(lg, ((big - lg.width) // 2, (big - lg.height) // 2))
    out = canvas.resize((size, size), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
    if rounded:
        m = Image.new('L', (big, big), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * 0.22), fill=255)
        out = out.convert('RGBA')
        out.putalpha(m.resize((size, size), Image.LANCZOS))
    return out

P = os.path.join(ROOT, 'public')
tile(192, 0.80, True).save(os.path.join(P, 'icon-192.png'), optimize=True)
tile(512, 0.80, True).save(os.path.join(P, 'icon-512.png'), optimize=True)
tile(512, 0.60, False).save(os.path.join(P, 'icon-maskable-512.png'), optimize=True)
tile(180, 0.72, False).save(os.path.join(P, 'apple-touch-icon.png'), optimize=True)
tile(32, 0.90, True).save(os.path.join(P, 'favicon-32.png'), optimize=True)
tile(96, 0.84, True).save(os.path.join(P, 'logo-96.png'), optimize=True)
print('ok', logo.size)

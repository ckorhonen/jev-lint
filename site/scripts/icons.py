#!/usr/bin/env python3
"""Pixel-art favicon set for jevlint.dev: a white 'j' and a green cursor on black.
Writes public/favicon.svg, favicon.ico (16/32/48), apple-touch-icon.png (180), icon-192.png, icon-512.png."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(HERE, "..", "public")
BG, FG, GREEN = (5, 5, 5), (242, 242, 242), (70, 210, 125)
N = 16  # 16×16 grid
J = [(9, 2, 2, 2), (9, 5, 2, 8), (5, 12, 5, 2), (4, 10, 2, 3)]  # x, y, w, h cells
CUR = (12, 11, 3, 3)


def svg():
    rects = "".join(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#f2f2f2"/>' for x, y, w, h in J)
    x, y, w, h = CUR
    rects += f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#46d27d"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {N} {N}" shape-rendering="crispEdges"><rect width="{N}" height="{N}" rx="2" fill="#050505"/>{rects}</svg>\n'


def png(size, pad=0.0):
    im = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(im)
    inner = size * (1 - 2 * pad)
    s = inner / N
    o = size * pad
    for (x, y, w, h), col in [(r, FG) for r in J] + [(CUR, GREEN)]:
        d.rectangle([o + x * s, o + y * s, o + (x + w) * s - 1, o + (y + h) * s - 1], fill=col)
    return im


open(os.path.join(PUB, "favicon.svg"), "w").write(svg())
png(48).save(os.path.join(PUB, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
png(180, 0.12).save(os.path.join(PUB, "apple-touch-icon.png"), optimize=True)
png(192, 0.12).save(os.path.join(PUB, "icon-192.png"), optimize=True)
png(512, 0.12).save(os.path.join(PUB, "icon-512.png"), optimize=True)
print("icons written")

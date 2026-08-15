#!/usr/bin/env python3
"""One-time deterministic generator for the 8 Rimuru rank logos.

Small flat-color PNGs (<200KB) stored as static repo assets, reused forever
so the artwork never changes across deploys. Run once:
    python3 scripts/generate-rank-logos.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "ranks")
os.makedirs(OUT, exist_ok=True)

SIZE = 512
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

RANKS = [
    # key, name, top color, bottom color, accent, initial
    ("bronze",   "BRONZE",   "#8C5A2B", "#5B3516", "#E8A45A", "B"),
    ("silver",   "SILVER",   "#C9D4DC", "#7B8B98", "#F4F8FB", "S"),
    ("gold",     "GOLD",     "#F6C453", "#B8860B", "#FFF2C4", "G"),
    ("platinum", "PLATINUM", "#9FD7E4", "#4E7487", "#EAF7FB", "P"),
    ("diamond",  "DIAMOND",  "#7DD3FC", "#2E86C1", "#E0F7FF", "D"),
    ("master",   "MASTER",   "#A78BFA", "#5B21B6", "#EDE9FE", "M"),
    ("legend",   "LEGEND",   "#F9A8D4", "#BE185D", "#FCE7F3", "L"),
    ("mythic",   "MYTHIC",   "#4C1D95", "#1E1B4B", "#C4B5FD", "M"),
]

def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        c = lerp(bottom, top, y / max(1, size - 1))
        for x in range(size):
            px[x, y] = c
    return img

def draw():
    for key, name, top, bottom, accent, initial in RANKS:
        top_rgb = hex_to_rgb(top)
        bottom_rgb = hex_to_rgb(bottom)
        accent_rgb = hex_to_rgb(accent)

        img = gradient(SIZE, top_rgb, bottom_rgb)
        d = ImageDraw.Draw(img)

        # subtle radial glow: concentric accent circles behind the badge
        for i, r in enumerate(range(230, 80, -18)):
            alpha = 22 if i == 0 else 8
            overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
            od = ImageDraw.Draw(overlay)
            od.ellipse([SIZE//2 - r, SIZE//2 - r, SIZE//2 + r, SIZE//2 + r],
                       fill=(*accent_rgb, alpha))
            img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
            d = ImageDraw.Draw(img)

        # shield / badge outline
        cx = SIZE // 2
        d.rounded_rectangle([cx - 170, 120, cx + 170, 392], radius=46,
                            outline=(*accent_rgb,), width=8)
        d.rounded_rectangle([cx - 158, 132, cx + 158, 380], radius=38,
                            outline=(*accent_rgb,), width=3)

        # big initial
        f_init = ImageFont.truetype(FONT_BOLD, 150)
        bbox = d.textbbox((0, 0), initial, font=f_init)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        d.text((cx - w/2 - bbox[0], 150 - bbox[1] + 8), initial, font=f_init, fill=(*accent_rgb,))

        # rank name
        f_name = ImageFont.truetype(FONT_BOLD, 46)
        bbox2 = d.textbbox((0, 0), name, font=f_name)
        w2 = bbox2[2] - bbox2[0]
        d.text((cx - w2/2 - bbox2[0], 300), name, font=f_name, fill=(255, 255, 255, 255))

        # subtitle
        sub = "RIMURU CASINO"
        f_sub = ImageFont.truetype(FONT_REG, 22)
        bbox3 = d.textbbox((0, 0), sub, font=f_sub)
        w3 = bbox3[2] - bbox3[0]
        d.text((cx - w3/2 - bbox3[0], 362), sub, font=f_sub, fill=(*accent_rgb,))

        path = os.path.join(OUT, f"{key}.png")
        img.save(path, optimize=True)
        print(f"{path} {os.path.getsize(path)//1024}KB")

if __name__ == "__main__":
    draw()

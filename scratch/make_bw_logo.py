#!/usr/bin/env python3
"""
Convert logo-transparent.png to a solid black silhouette for thermal printing.
- Any pixel with alpha > 30 → pure black (the entire logo shape)
- Transparent pixels → stay transparent
- Resize to 200x200 for receipt
"""
from PIL import Image
import os

src = "/Users/juvaid/grill and chill/grillandchill/assets/logo-transparent.png"
dst = "/Users/juvaid/grill and chill/grillandchill/assets/logo-receipt-bw.png"

img = Image.open(src).convert("RGBA")

pixels = img.load()
w, h = img.size

for y in range(h):
    for x in range(w):
        r, g, b, a = pixels[x, y]
        if a > 30:
            # Any visible pixel → solid black
            pixels[x, y] = (0, 0, 0, 255)
        else:
            # Transparent → keep transparent
            pixels[x, y] = (0, 0, 0, 0)

# Resize to 200x200 for receipt use
img_resized = img.resize((200, 200), Image.LANCZOS)
img_resized.save(dst, "PNG", optimize=True)

print(f"✅ Created B&W receipt logo: {dst}")
print(f"   Size: {os.path.getsize(dst)} bytes")
print(f"   Dimensions: {img_resized.size}")

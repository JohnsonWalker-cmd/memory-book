#!/usr/bin/env python3
"""Generate the PWA icon set.

Standard library only (zlib + struct) so it runs anywhere without installing
an imaging library. Run from the repo root after changing the palette:

    python3 tools/make-icons.py

Colours are taken from style.css (--bg, --card-bg, --accent, --accent-dark).
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

CARD_BG = (0xFF, 0xFA, 0xF0)
BG = (0xF8, 0xE9, 0xE6)
ACCENT = (0xC0, 0x39, 0x2B)
ACCENT_DARK = (0xA5, 0x2A, 0x2A)

SS = 4  # supersampling factor per axis, for antialiasing


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def in_heart(x, y):
    """Implicit heart: (x^2 + y^2 - 1)^3 - x^2 * y^3 <= 0, y pointing up."""
    a = x * x + y * y - 1
    return a * a * a - x * x * y * y * y <= 0


def in_rounded_square(x, y, half, radius):
    dx = abs(x) - (half - radius)
    dy = abs(y) - (half - radius)
    if dx <= 0 or dy <= 0:
        return abs(x) <= half and abs(y) <= half
    return math.hypot(dx, dy) <= radius


def render(size, maskable):
    """Return RGBA bytes for one icon.

    maskable=True fills the whole canvas (Android crops to its own shape, so
    the heart is kept inside the 80%-diameter safe zone). Otherwise the icon is
    a rounded square with transparent corners.
    """
    # Larger span => heart occupies less of the canvas. The maskable variant is
    # kept well inside the 80%-diameter safe zone, since Android crops to its
    # own shape (circle, squircle, teardrop) and would otherwise clip the point.
    heart_span = 1.95 if maskable else 1.45
    px = bytearray()

    for py in range(size):
        row = bytearray()
        for pxi in range(size):
            r_acc = g_acc = b_acc = a_acc = 0
            for sy in range(SS):
                for sx in range(SS):
                    # Normalised coords in [-1, 1], y up.
                    nx = ((pxi + (sx + 0.5) / SS) / size) * 2 - 1
                    ny = 1 - ((py + (sy + 0.5) / SS) / size) * 2

                    if maskable:
                        inside_bg = True
                    else:
                        inside_bg = in_rounded_square(nx, ny, 1.0, 0.42)

                    if not inside_bg:
                        continue

                    # Vertical background gradient, cream at top.
                    bg = lerp(CARD_BG, BG, (1 - ny) / 2)

                    hx = nx * heart_span
                    hy = ny * heart_span + 0.25
                    if in_heart(hx, hy):
                        # Shade the heart top-left to bottom-right.
                        t = min(max((nx - ny + 1) / 2, 0), 1)
                        c = lerp(ACCENT, ACCENT_DARK, t)
                    else:
                        c = bg

                    r_acc += c[0]
                    g_acc += c[1]
                    b_acc += c[2]
                    a_acc += 255

            n = SS * SS
            if a_acc == 0:
                row += bytes((0, 0, 0, 0))
            else:
                covered = a_acc // 255
                row += bytes(
                    (r_acc // covered, g_acc // covered, b_acc // covered, a_acc // n)
                )
        px += b"\x00" + row  # filter type 0 per scanline

    return bytes(px)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def flatten_alpha(raw, size, bg):
    """Composite onto an opaque background (iOS shows alpha as black)."""
    out = bytearray()
    i = 0
    for _ in range(size):
        out.append(raw[i])
        i += 1
        for _ in range(size):
            r, g, b, a = raw[i], raw[i + 1], raw[i + 2], raw[i + 3]
            t = a / 255
            out += bytes(
                (
                    round(bg[0] + (r - bg[0]) * t),
                    round(bg[1] + (g - bg[1]) * t),
                    round(bg[2] + (b - bg[2]) * t),
                    255,
                )
            )
            i += 4
    return bytes(out)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    targets = [
        ("icon-192.png", 192, False, None),
        ("icon-512.png", 512, False, None),
        ("icon-maskable-512.png", 512, True, None),
        ("apple-touch-icon.png", 180, False, CARD_BG),
        ("favicon-32.png", 32, False, None),
    ]

    for name, size, maskable, flatten in targets:
        raw = render(size, maskable)
        if flatten:
            raw = flatten_alpha(raw, size, flatten)
        written = write_png(os.path.join(OUT_DIR, name), size, raw)
        print(f"{name:24} {size:>4}px  {written:>7,} bytes")


if __name__ == "__main__":
    main()

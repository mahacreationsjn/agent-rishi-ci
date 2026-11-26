"""Agent Rishi's icons from its logo (docs/brand/agent-rishi.png, 8-bit RGBA): the web app's
favicon, PWA and touch icons, the sidebar logo and the desktop app's icons. Python standard
library only. Run: python3 scripts/make-icons.py (the outputs are committed)."""
import struct
import sys
import zlib


def decode(path):
    d = open(path, "rb").read()
    assert d[:8] == b"\x89PNG\r\n\x1a\n"
    i, idat, w = 8, b"", 0
    while i < len(d):
        n = struct.unpack(">I", d[i:i + 4])[0]
        t = d[i + 4:i + 8]
        if t == b"IHDR":
            w, h, depth, ctype, _, _, inter = struct.unpack(">IIBBBBB", d[i + 8:i + 21])
            assert depth == 8 and ctype == 6 and inter == 0, "expects 8-bit RGBA, not interlaced"
        elif t == b"IDAT":
            idat += d[i + 8:i + 8 + n]
        i += 12 + n
    raw = zlib.decompress(idat)
    bpp, stride = 4, w * 4
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def encode(path, w, h, px):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * w * 4:(y + 1) * w * 4]

    def chunk(t, data):
        c = struct.pack(">I", len(data)) + t + data
        return c + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


def bbox(w, h, px, min_alpha=16):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = px[y * w * 4:(y + 1) * w * 4]
        for x in range(w):
            if row[x * 4 + 3] > min_alpha:
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                y1 = y
    return x0, y0, x1, y1


def render(src, sw, sh, crop, size, scale, bg=None):
    """The square `crop` (x, y, side) of src drawn at `scale` of a size x size canvas."""
    cx, cy, side = crop
    d = size * scale
    off = (size - d) / 2
    out = bytearray(size * size * 4)
    ratio = side / d
    for oy in range(size):
        for ox in range(size):
            # Source area covered by this output pixel.
            sx0 = cx + (ox - off) * ratio
            sy0 = cy + (oy - off) * ratio
            sx1, sy1 = sx0 + ratio, sy0 + ratio
            r = g = b = a = wsum = 0.0
            iy = int(sy0 // 1)
            while iy < sy1:
                wy = min(sy1, iy + 1) - max(sy0, iy)
                ix = int(sx0 // 1)
                while ix < sx1:
                    wx = min(sx1, ix + 1) - max(sx0, ix)
                    wt = wx * wy
                    if 0 <= ix < sw and 0 <= iy < sh and wt > 0:
                        k = (iy * sw + ix) * 4
                        al = src[k + 3] / 255
                        r += src[k] * al * wt
                        g += src[k + 1] * al * wt
                        b += src[k + 2] * al * wt
                        a += al * wt
                    wsum += wt
                    ix += 1
                iy += 1
            if wsum:
                r, g, b, a = r / wsum, g / wsum, b / wsum, a / wsum
            if bg:
                br, bgc, bb = bg
                r = r + br * (1 - a)
                g = g + bgc * (1 - a)
                b = b + bb * (1 - a)
                a = 1.0
                pr, pg, pb = r, g, b
            else:
                pr, pg, pb = (r / a, g / a, b / a) if a > 0 else (0, 0, 0)
            k = (oy * size + ox) * 4
            out[k] = max(0, min(255, round(pr)))
            out[k + 1] = max(0, min(255, round(pg)))
            out[k + 2] = max(0, min(255, round(pb)))
            out[k + 3] = max(0, min(255, round(a * 255)))
    return out


if __name__ == "__main__":
    import base64
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    w, h, px = decode(root / "docs/brand/agent-rishi.png")
    x0, y0, x1, y1 = bbox(w, h, px)
    side = max(x1 - x0 + 1, y1 - y0 + 1)
    crop = ((x0 + x1 + 1) / 2 - side / 2, (y0 + y1 + 1) / 2 - side / 2, side)
    white = (255, 255, 255)
    # path, size, share of the canvas the robot fills, background (None: transparent)
    targets = [
        ("apps/web/public/logo.png", 128, 1.0, None),
        ("apps/web/public/icons/icon-192.png", 192, 0.9, None),
        ("apps/web/public/icons/icon-512.png", 512, 0.9, None),
        ("apps/web/public/icons/maskable-192.png", 192, 0.66, white),
        ("apps/web/public/icons/maskable-512.png", 512, 0.66, white),
        ("apps/web/public/apple-touch-icon.png", 180, 0.82, white),
        ("apps/desktop/build/icon.png", 1024, 0.86, None),
        ("apps/desktop/assets/icon.png", 256, 0.9, None),
        ("apps/desktop/assets/tray.png", 16, 1.0, None),
        ("apps/desktop/assets/tray@2x.png", 32, 1.0, None),
    ]
    for rel, size, scale, bg in targets:
        encode(root / rel, size, size, render(px, w, h, crop, size, scale, bg))
        print("wrote", rel)
    # The favicon is an SVG (the attention badge draws on it) holding a 64px PNG.
    fav = root / "apps/web/public/favicon-64.png"
    encode(fav, 64, 64, render(px, w, h, crop, 64, 1.0))
    data = base64.b64encode(fav.read_bytes()).decode()
    fav.unlink()
    (root / "apps/web/public/favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        "<title>Agent Rishi</title>"
        f'<image width="64" height="64" href="data:image/png;base64,{data}"/></svg>\n'
    )
    print("wrote apps/web/public/favicon.svg")

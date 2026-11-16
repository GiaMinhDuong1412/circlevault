"""Thêm chữ tiếng Việt vào font TextMeshPro (TMP) đã vẽ sẵn của game Unity.

Font TMP = MonoBehaviour TMP_FontAsset (bảng glyph + bảng chữ) + ảnh atlas Texture2D (thường là SDF: mỗi điểm ảnh là
khoảng cách tới viền chữ). Game IL2CPP không có typetree nên đọc/ghi bảng ở dạng THÔ:
  … m_GlyphTable (int32 số lượng + bản ghi 48/52 byte) · m_CharacterTable (int32 + bản ghi 16/12 byte) · m_AtlasTextures (PPtr[]) …
  … m_AtlasWidth, m_AtlasHeight, m_AtlasPadding, m_AtlasRenderMode …

Cách thêm chữ (giữ đúng kiểu chữ của game): lấy CHỮ GỐC trong atlas (a, o, u, â, ê…), dựng lại hình chữ từ SDF, rồi ghép
DẤU lấy từ một font có đủ tiếng Việt (dấu = chữ đầy đủ trừ chữ gốc, cùng font đó), đặt dấu theo khung chữ gốc của game,
tính lại SDF cùng độ dốc với atlas gốc, xếp vào chỗ trống của atlas (hết chỗ thì nhân đôi chiều cao, sửa kích thước
trong font + material). Chữ mới có mã glyph riêng (số chưa dùng, < 65536 như mã glyph thật), không đụng chữ cũ.
"""
from __future__ import annotations

import io
import struct
import unicodedata

SDF_MODES = {4134, 8230, 16422, 32806, 4169, 4165}
RENDER_MODES = {4117, 4118, 4121, 4122} | SDF_MODES
SS = 4                                     # siêu lấy mẫu khi dựng hình chữ

VI = sorted(set("ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯư") | {chr(c) for c in range(0x1EA0, 0x1EFA)})


class TmpError(RuntimeError):
    pass


# ================================================================== đọc / ghi dữ liệu thô của TMP_FontAsset
def _chars_at(raw: bytes, pos: int, size: int) -> list[tuple[int, int]] | None:
    """Bảng chữ bắt đầu tại pos (int32 số lượng) – None nếu không hợp lệ."""
    if pos + 4 > len(raw):
        return None
    n = struct.unpack_from("<i", raw, pos)[0]
    if not (8 <= n <= 200000) or pos + 4 + n * size > len(raw):
        return None
    out = []
    for k in range(n):
        q = pos + 4 + k * size
        if size == 16:
            t, u, g, sc = struct.unpack_from("<IIIf", raw, q)
            if t != 1:
                return None
        else:
            u, g, sc = struct.unpack_from("<IIf", raw, q)
        if sc != 1.0 or u > 0x10FFFF:
            return None
        out.append((u, g))
    return out


def _glyph(raw: bytes, q: int, size: int) -> dict | None:
    idx, w, h, bx, by, adv, rx, ry, rw, rh, sc, ai = struct.unpack_from("<I5f4if i", raw, q)
    cd = struct.unpack_from("<i", raw, q + 48)[0] if size == 52 else 0
    if sc != 1.0 or not (0 <= ai < 64) or min(rx, ry, rw, rh) < 0 or max(rx, ry, rw, rh) > 65536:
        return None
    if not all(abs(v) < 100000 for v in (w, h, bx, by, adv)):
        return None
    if size == 52 and not (0 <= cd < 16):
        return None
    return {"index": idx, "w": w, "h": h, "bx": bx, "by": by, "adv": adv, "rect": [rx, ry, rw, rh], "scale": sc,
            "atlas": ai, "cd": cd}


def parse(raw: bytes) -> dict:
    """Tìm bảng glyph + bảng chữ + atlas + kích thước atlas trong dữ liệu thô."""
    best = None
    for csize in (16, 12):
        for pos in range(0, len(raw) - 4, 4):
            n = struct.unpack_from("<i", raw, pos)[0]
            if not (8 <= n <= 200000) or pos + 4 + n * csize > len(raw):
                continue
            chars = _chars_at(raw, pos, csize)
            if not chars or sum(1 for u, _ in chars if 0x20 <= u < 0x7F) < 20:
                continue
            for gsize in (52, 48):                         # bảng glyph nằm NGAY TRƯỚC bảng chữ
                for gn in range(max(1, len(chars) // 2), len(chars) * 3 + 64):
                    gpos = pos - 4 - gn * gsize
                    if gpos < 0:
                        break
                    if struct.unpack_from("<i", raw, gpos)[0] != gn:
                        continue
                    glyphs = [_glyph(raw, gpos + 4 + k * gsize, gsize) for k in range(gn)]
                    if any(g is None for g in glyphs):
                        continue
                    ids = {g["index"] for g in glyphs}
                    if sum(1 for _, g in chars if g in ids) < len(chars) * 0.9:
                        continue
                    best = {"gpos": gpos, "gsize": gsize, "glyphs": glyphs, "cpos": pos, "csize": csize, "chars": chars,
                            "cend": pos + 4 + len(chars) * csize}
                    break
                if best:
                    break
            if best:
                break
        if best:
            break
    if not best:
        raise TmpError("không đọc được bảng chữ của font TextMeshPro")
    q = best["cend"]
    na = struct.unpack_from("<i", raw, q)[0]
    if not (1 <= na <= 16):
        raise TmpError("không thấy ảnh atlas của font")
    best["atlas_ptr"] = struct.unpack_from("<iq", raw, q + 4)            # (fileID, pathID) của atlas đầu tiên
    best["wh"] = None
    find_wh(raw, best)
    return best


def find_wh(raw: bytes, lay: dict, size: tuple[int, int] | None = None):
    """Vị trí m_AtlasWidth/Height/Padding/RenderMode (sau bảng chữ). size = kích thước ảnh atlas thật nếu đã biết."""
    q = lay["cend"]
    for p in range(q, min(len(raw) - 16, q + 512 * 1024), 4):
        w, h, pad, mode = struct.unpack_from("<iiii", raw, p)
        if mode in RENDER_MODES and 16 <= w <= 16384 and 16 <= h <= 16384 and 0 <= pad <= 128 and (size is None or (w, h) == size):
            lay["wh"] = p
            lay["size"], lay["pad"], lay["mode"] = (w, h), pad, mode
            return True
    return False


def build_raw(raw: bytes, lay: dict, glyphs: list[dict], chars: list[tuple[int, int]], size: tuple[int, int] | None) -> bytes:
    out = bytearray(raw[:lay["gpos"]])
    out += struct.pack("<i", len(glyphs))
    for g in glyphs:
        rx, ry, rw, rh = g["rect"]
        out += struct.pack("<I5f4ifi", g["index"], g["w"], g["h"], g["bx"], g["by"], g["adv"], rx, ry, rw, rh, g["scale"], g["atlas"])
        if lay["gsize"] == 52:
            out += struct.pack("<i", g.get("cd", 0))
    out += struct.pack("<i", len(chars))
    for u, gi in chars:
        out += struct.pack("<IIIf", 1, u, gi, 1.0) if lay["csize"] == 16 else struct.pack("<IIf", u, gi, 1.0)
    shift = len(out) - lay["cend"]
    out += raw[lay["cend"]:]
    if size and lay.get("wh") is not None:
        struct.pack_into("<ii", out, lay["wh"] + shift, size[0], size[1])
    return bytes(out)


# ================================================================== hình chữ
def _np():
    import numpy as np
    return np


def _upsample(region, s: int):
    """Phóng mảng float (SDF) lên s lần bằng nội suy song tuyến."""
    from PIL import Image
    np = _np()
    h, w = region.shape
    im = Image.fromarray(region.astype("float32"), mode="F").resize((w * s, h * s), Image.Resampling.BILINEAR)
    return np.asarray(im, dtype="float32")


def _bbox(mask):
    np = _np()
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _render(font, ch: str, origin: tuple[int, int], shape: tuple[int, int]):
    """Mặt nạ (h, w) của chữ ch vẽ với gốc (điểm chân chữ) tại origin."""
    from PIL import Image, ImageDraw
    np = _np()
    im = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(im).text(origin, ch, font=font, fill=255, anchor="ls")
    return np.asarray(im) >= 128


def _components(mask) -> list:
    """Tách các mảng rời (dấu sắc, dấu mũ…) – trả danh sách mặt nạ."""
    np = _np()
    lab = np.zeros(mask.shape, dtype="int32")
    comps = []
    ys, xs = np.nonzero(mask)
    h, w = mask.shape
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if lab[y0, x0]:
            continue
        cid = len(comps) + 1
        stack = [(y0, x0)]
        lab[y0, x0] = cid
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = cid
                        stack.append((yy, xx))
        comps.append(pts)
    out = []
    for pts in comps:
        m = np.zeros(mask.shape, dtype=bool)
        arr = np.array(pts)
        m[arr[:, 0], arr[:, 1]] = True
        out.append(m)
    return out


def _dilate(mask, r: int):
    np = _np()
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dy * dy + dx * dx > r * r:
                continue
            out |= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def _sdf_texels(mask, s: int, x0: int, y0: int, nx: int, ny: int, k: float | None, sdf: bool):
    """Giá trị atlas cho lưới texel (ny, nx) bắt đầu ở điểm ảnh siêu mẫu (x0, y0) của mask (đơn vị siêu mẫu)."""
    np = _np()
    h, w = mask.shape
    if not sdf:
        out = np.zeros((ny, nx), dtype="float32")
        for j in range(ny):
            for i in range(nx):
                ys, xs = y0 + j * s, x0 + i * s
                if 0 <= ys < h and 0 <= xs < w:
                    out[j, i] = mask[max(ys, 0):ys + s, max(xs, 0):xs + s].mean()
        return out
    ev = mask ^ np.roll(mask, 1, 0)             # đổi giữa hàng y-1 và y → viền ở tọa độ y
    eh = mask ^ np.roll(mask, 1, 1)
    ev[0, :] = False
    eh[:, 0] = False
    vy, vx = np.nonzero(ev)
    hy, hx = np.nonzero(eh)
    pts = np.concatenate([np.stack([vy, vx + 0.5], 1), np.stack([hy + 0.5, hx], 1)]).astype("float32")
    if not len(pts):
        pts = np.zeros((1, 2), "float32") - 1e6
    cy = y0 + (np.arange(ny) + 0.5) * s
    cx = x0 + (np.arange(nx) + 0.5) * s
    gy, gx = np.meshgrid(cy, cx, indexing="ij")
    q = np.stack([gy.ravel(), gx.ravel()], 1).astype("float32")
    best = np.full(len(q), 1e9, dtype="float32")
    for a in range(0, len(pts), 512):
        p = pts[a:a + 512]
        d = ((q[:, None, :] - p[None, :, :]) ** 2).sum(-1).min(1)
        best = np.minimum(best, d)
    dist = np.sqrt(best) / s
    iy = np.clip(gy.ravel().astype(int), 0, h - 1)
    ix = np.clip(gx.ravel().astype(int), 0, w - 1)
    inside = mask[iy, ix] & (gy.ravel() >= 0) & (gy.ravel() < h) & (gx.ravel() >= 0) & (gx.ravel() < w)
    sd = np.where(inside, dist, -dist).reshape(ny, nx).astype("float32")
    if k is None:
        return sd
    return np.clip(0.5 + k * sd, 0, 1)


def _slope(atlas, glyphs: list[dict], pad: int, sdf: bool) -> float:
    """Độ dốc SDF của atlas gốc: giá trị = 0.5 + k·(khoảng cách texel) – đo trên vài chữ có sẵn."""
    np = _np()
    if not sdf:
        return 1.0
    H = atlas.shape[0]
    ks = []
    for g in sorted(glyphs, key=lambda g: -g["rect"][2] * g["rect"][3])[:6]:
        rx, ry, rw, rh = g["rect"]
        top = H - (ry + rh)
        y0, x0 = max(top - pad, 0), max(rx - pad, 0)
        reg = atlas[y0:top + rh + pad, x0:rx + rw + pad]
        if reg.size < 16:
            continue
        up = _upsample(reg, SS)
        m = up >= 0.5
        vals = _sdf_texels(m, SS, 0, 0, reg.shape[1], reg.shape[0], None, True)     # khoảng cách có dấu (texel)
        a = reg - 0.5
        sel = (np.abs(a) < 0.4) & (np.abs(vals) > 0.75)
        if sel.sum() > 20:
            ks.append(float((a[sel] * vals[sel]).sum() / (vals[sel] ** 2).sum()))
    if ks:
        return float(np.median(ks))
    return 1.0 / max(2 * pad, 1)


def _base_of(c: str, have: set[str]) -> tuple[str, str]:
    """(chữ gốc có trong font game, phần dấu cần thêm). Ưu tiên chữ gốc đã có dấu mũ/móc/trăng (â ê ô…)."""
    if c in "đĐ":
        return ("d" if c == "đ" else "D"), ""
    d = unicodedata.normalize("NFD", c)
    shape = "".join(m for m in d[1:] if m in "̛̂̆")
    for cand in (d[0] + shape, d[0]):
        x = unicodedata.normalize("NFC", cand)
        if len(x) == 1 and x in have:
            return x, ""
    return d[0], ""


def _drop_tittle(mask):
    """Bỏ mảng nhỏ nằm trên cùng (dấu chấm của i/j)."""
    comps = _components(mask)
    if len(comps) < 2:
        return mask
    comps.sort(key=lambda m: -int(m.sum()))
    body = _bbox(comps[0])
    out = mask.copy()
    for m in comps[1:]:
        b = _bbox(m)
        if b[3] <= body[1] + (body[3] - body[1]) * 0.3:
            out &= ~m
    return out


def guess_cat(lay: dict, atlas) -> str:
    """Font có chân (serif) hay không – đo nét ngang ở đầu/chân chữ I, l so với thân."""
    np = _np()
    H = atlas.shape[0]
    by_u = {u: g for u, g in lay["chars"]}
    gl = {g["index"]: g for g in lay["glyphs"]}
    ratios = []
    for ch in "Il":
        g = gl.get(by_u.get(ord(ch)))
        if not g or g["rect"][2] <= 0 or g["atlas"] != 0:
            continue
        rx, ry, rw, rh = g["rect"]
        top = H - (ry + rh)
        m = atlas[top:top + rh, rx:rx + rw] >= 0.5
        if m.shape[0] < 8:
            continue
        w = m.sum(1)
        n = max(1, m.shape[0] // 8)
        foot = max(w[:n].max(), w[-n:].max())
        mid = np.median(w[m.shape[0] // 3: 2 * m.shape[0] // 3])
        if mid > 0:
            ratios.append(foot / mid)
    return "serif" if ratios and max(ratios) >= 1.8 else "sans"


class Composer:
    """Dựng chữ Việt cho một font TMP: atlas (mảng float 0..1, hàng 0 = TRÊN cùng như ảnh), bảng glyph/chữ, font dấu."""

    def __init__(self, atlas, lay: dict, mark_font: bytes):
        from PIL import ImageFont
        self.np = _np()
        self.atlas = atlas
        self.lay = lay
        self.pad = int(lay["pad"]) if lay.get("pad") else 5
        self.sdf = (lay.get("mode") in SDF_MODES) if lay.get("mode") else True
        self.by_index = {g["index"]: g for g in lay["glyphs"]}
        self.char_glyph = {u: self.by_index.get(g) for u, g in lay["chars"]}
        self.have = {chr(u) for u, g in self.char_glyph.items() if g is not None}
        self.k = _slope(atlas, [g for g in lay["glyphs"] if g["atlas"] == 0 and g["rect"][2] > 2], self.pad, self.sdf)
        if not lay.get("pad") and self.sdf and self.k > 0:
            self.pad = max(2, min(32, int(round(1 / (2 * self.k)))))       # không đọc được độ đệm: suy từ độ dốc SDF
        self.font_data = mark_font
        self.ref = ImageFont.truetype(io.BytesIO(mark_font), 200)
        self._fonts: dict[int, object] = {}

    def _font(self, size: int):
        from PIL import ImageFont
        size = max(4, min(int(size), 2000))
        if size not in self._fonts:
            self._fonts[size] = ImageFont.truetype(io.BytesIO(self.font_data), size)
        return self._fonts[size]

    def _game_mask(self, g: dict):
        """Mặt nạ siêu mẫu của chữ gốc + vị trí: trả (mask, ox, oy) với (ox, oy) = điểm gốc (bút, chân chữ) trong mask."""
        np = self.np
        H = self.atlas.shape[0]
        rx, ry, rw, rh = g["rect"]
        pad = self.pad
        top = H - (ry + rh)
        reg = np.zeros((rh + 2 * pad, rw + 2 * pad), dtype="float32")
        y0, x0 = top - pad, rx - pad
        sy0, sx0 = max(y0, 0), max(x0, 0)
        src = self.atlas[sy0:top + rh + pad, sx0:rx + rw + pad]
        reg[sy0 - y0:sy0 - y0 + src.shape[0], sx0 - x0:sx0 - x0 + src.shape[1]] = src
        m = _upsample(reg, SS) >= 0.5
        # điểm ảnh (pad, pad) của vùng = góc trên trái của khung chữ = (bearingX, bearingY) so với gốc
        ox = int(round((pad - g["bx"]) * SS))
        oy = int(round((pad + g["by"]) * SS))
        return m, ox, oy

    def glyph(self, c: str) -> tuple[dict, object] | None:
        """(thông số glyph mới, mảng atlas của vùng có đệm) cho chữ c – None nếu không dựng được."""
        np = self.np
        base, _ = _base_of(c, self.have)
        g = self.char_glyph.get(ord(base))
        if g is None or g["rect"][2] <= 0 or g["atlas"] != 0:
            return None
        gm, gox, goy = self._game_mask(g)
        gb = _bbox(gm)
        if gb is None:
            return None
        gh = gb[3] - gb[1]
        # font dấu: cỡ sao cho chữ gốc cao bằng chữ gốc của game
        rb = self.ref.getbbox(base, anchor="ls")
        rh = rb[3] - rb[1]
        if rh <= 0:
            return None
        f = self._font(200 * gh / rh)
        fb_box = f.getbbox(c, anchor="ls")
        bb_box = f.getbbox(base, anchor="ls")
        mg = int(gh * 1.2) + 8
        W = int(max(fb_box[2], bb_box[2]) - min(fb_box[0], bb_box[0])) + 2 * mg
        Hh = int(max(fb_box[3], bb_box[3]) - min(fb_box[1], bb_box[1])) + 2 * mg
        org = (mg - int(min(fb_box[0], bb_box[0])), mg - int(min(fb_box[1], bb_box[1])))
        full = _render(f, c, org, (Hh, W))
        bm = _render(f, base, org, (Hh, W))
        fbb = _bbox(bm)
        if fbb is None:
            return None
        marks = full & ~_dilate(bm, max(1, SS // 2 + 1))
        comps = [m for m in _components(marks) if m.sum() >= max(6, (gh * gh) // 900)]
        if comps:                                     # bỏ mảnh vụn (dấu mũ lệch chút giữa "â" và "ấ")
            big = max(int(m.sum()) for m in comps)
            comps = [m for m in comps if m.sum() >= big * 0.25]
        if not comps and c != base:
            return None
        # đặt từng mảng dấu theo khung chữ gốc của game (tọa độ so với gốc bút, y hướng xuống)
        G = (gb[0] - gox, gb[1] - goy, gb[2] - gox, gb[3] - goy)
        Fb = (fbb[0] - org[0], fbb[1] - org[1], fbb[2] - org[0], fbb[3] - org[1])
        fw, fh = max(Fb[2] - Fb[0], 1), max(Fb[3] - Fb[1], 1)
        gw, ghh = max(G[2] - G[0], 1), max(G[3] - G[1], 1)
        tol = fh * 0.04
        placed = []
        for m in comps:
            b = _bbox(m)
            bx0, by0, bx1, by1 = b[0] - org[0], b[1] - org[1], b[2] - org[0], b[3] - org[1]
            cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
            ncx = G[0] + (cx - Fb[0]) * gw / fw
            if by1 <= Fb[1] + tol:                     # dấu trên: giữ khoảng hở với đỉnh chữ
                dy = G[1] - Fb[1]
            elif by0 >= Fb[3] - tol:                   # dấu dưới (nặng)
                dy = G[3] - Fb[3]
            else:                                      # dính vào chữ (móc ơ ư, gạch đ)
                dy = G[1] + (cy - Fb[1]) * ghh / fh - cy
            placed.append((m[b[1]:b[3], b[0]:b[2]], int(round(bx0 + ncx - cx)), int(round(by0 + dy))))
        if base in "ij" and any(p[2] + p[0].shape[0] <= G[1] + gh * 0.45 for p in placed):
            gm = _drop_tittle(gm)                      # ĩ ỉ: bỏ dấu chấm của i trước khi đặt dấu thanh
        # khung chung (so với gốc bút)
        x0 = min([G[0]] + [p[1] for p in placed])
        y0 = min([G[1]] + [p[2] for p in placed])
        x1 = max([G[2]] + [p[1] + p[0].shape[1] for p in placed])
        y1 = max([G[3]] + [p[2] + p[0].shape[0] for p in placed])
        # biên theo texel, có đệm
        L, T = int(np.floor(x0 / SS)), int(np.floor(y0 / SS))
        R, B = int(np.ceil(x1 / SS)), int(np.ceil(y1 / SS))
        pad = self.pad
        cw, ch = (R - L + 2 * pad) * SS, (B - T + 2 * pad) * SS
        canvas = np.zeros((ch, cw), dtype=bool)
        cox, coy = (pad - L) * SS, (pad - T) * SS        # gốc bút trong canvas
        # chữ gốc
        sx, sy = cox - gox, coy - goy
        ys0, xs0 = max(sy, 0), max(sx, 0)
        ys1, xs1 = min(sy + gm.shape[0], ch), min(sx + gm.shape[1], cw)
        if ys1 > ys0 and xs1 > xs0:
            canvas[ys0:ys1, xs0:xs1] |= gm[ys0 - sy:ys1 - sy, xs0 - sx:xs1 - sx]
        for m, px, py in placed:
            ax, ay = cox + px, coy + py
            ya, xa = max(ay, 0), max(ax, 0)
            yb, xb = min(ay + m.shape[0], ch), min(ax + m.shape[1], cw)
            if yb > ya and xb > xa:
                canvas[ya:yb, xa:xb] |= m[ya - ay:yb - ay, xa - ax:xb - ax]
        tex = _sdf_texels(canvas, SS, 0, 0, R - L + 2 * pad, B - T + 2 * pad, self.k, self.sdf)
        meta = {"w": float(R - L), "h": float(B - T), "bx": float(L), "by": float(-T), "adv": g["adv"],
                "rect": [0, 0, R - L, B - T], "scale": 1.0, "atlas": 0, "cd": g.get("cd", 0)}
        return meta, tex


# ================================================================== xếp vào atlas
class Packer:
    def __init__(self, atlas, glyphs: list[dict], pad: int):
        np = _np()
        self.np = np
        self.atlas = atlas
        self.pad = pad
        H, W = atlas.shape
        self.occ = np.zeros((H, W), dtype=bool)
        for g in glyphs:
            if g["atlas"] != 0:
                continue
            rx, ry, rw, rh = g["rect"]
            top = H - (ry + rh)
            self.occ[max(top - pad - 1, 0):top + rh + pad + 1, max(rx - pad - 1, 0):rx + rw + pad + 1] = True
        self.occ |= atlas > 0.02                       # điểm ảnh đã có nét (an toàn khi bảng glyph thiếu chữ)
        self.grown = False

    def _grow(self):
        np = self.np
        H, W = self.atlas.shape
        self.atlas = np.vstack([np.zeros((H, W), dtype=self.atlas.dtype), self.atlas])    # thêm phía TRÊN: chữ cũ giữ nguyên y
        self.occ = np.vstack([np.zeros((H, W), dtype=bool), self.occ])
        self.grown = True

    def place(self, tex) -> tuple[int, int]:
        """Đặt mảng tex (có đệm) vào chỗ trống; trả (x, y) GÓC DƯỚI TRÁI của vùng có đệm theo tọa độ Unity (y từ dưới)."""
        np = self.np
        th, tw = tex.shape[0] + 1, tex.shape[1] + 1
        for _ in range(4):
            H, W = self.occ.shape
            if th <= H and tw <= W:
                ii = np.zeros((H + 1, W + 1), dtype="int32")
                ii[1:, 1:] = self.occ.cumsum(0).cumsum(1)
                s = ii[th:, tw:] - ii[:-th, tw:] - ii[th:, :-tw] + ii[:-th, :-tw]
                free = np.argwhere(s == 0)
                if len(free):
                    y, x = (int(v) for v in free[np.lexsort((free[:, 1], -free[:, 0]))][0])   # ưu tiên hàng dưới cùng
                    self.atlas[y:y + tex.shape[0], x:x + tex.shape[1]] = tex
                    self.occ[y:y + th, x:x + tw] = True
                    return x, H - (y + tex.shape[0])
            if H >= 8192:
                break
            self._grow()
        raise TmpError("atlas đã đầy")


def add_vietnamese(raw: bytes, atlas_img, mark_font: bytes, want: list[str] | None = None) -> tuple[bytes, object, int, list[str]]:
    """raw của TMP_FontAsset + ảnh atlas (PIL 'L' hoặc RGBA – lấy kênh alpha) → (raw mới, ảnh mới 'L', số chữ thêm, chữ không dựng được)."""
    from PIL import Image
    np = _np()
    lay = parse(raw)
    img = atlas_img
    if img.mode != "L":
        img = img.getchannel("A") if "A" in img.getbands() else img.convert("L")
    atlas = np.asarray(img, dtype="float32") / 255.0
    real = (atlas.shape[1], atlas.shape[0])
    if lay.get("size") and real != tuple(lay["size"]) and not find_wh(raw, lay, real):
        lay["wh"] = None                               # không chắc vị trí: không sửa kích thước (atlas phải đủ chỗ)
        lay.pop("size", None)
    comp = Composer(atlas, lay, mark_font)
    want = [c for c in (want or VI) if c not in comp.have]
    if not want:
        return raw, None, 0, []
    pk = Packer(atlas.copy(), lay["glyphs"], comp.pad)
    glyphs = list(lay["glyphs"])
    chars = list(lay["chars"])
    used = {g["index"] for g in glyphs}
    nid = max(used) + 1 if max(used) + len(want) < 65000 else 1
    fail = []
    for c in want:
        try:
            r = comp.glyph(c)
        except Exception:       # chữ lạ: bỏ qua
            r = None
        if r is None:
            fail.append(c)
            continue
        meta, tex = r
        x, y = pk.place(tex)
        while nid in used:
            nid += 1
        used.add(nid)
        meta["index"] = nid
        meta["rect"] = [x + comp.pad, y + comp.pad, meta["rect"][2], meta["rect"][3]]
        glyphs.append(meta)
        chars.append((ord(c), nid))
    added = len(want) - len(fail)
    if not added:
        return raw, None, 0, fail
    H, W = pk.atlas.shape
    if pk.grown and lay.get("wh") is None:
        raise TmpError("atlas hết chỗ mà không tìm thấy kích thước atlas trong font")
    new_raw = build_raw(raw, lay, glyphs, chars, (W, H) if pk.grown else None)
    a = Image.fromarray((np.clip(pk.atlas, 0, 1) * 255 + 0.5).astype("uint8"), mode="L")
    white = Image.new("L", a.size, 255)
    out = Image.merge("RGBA", (white, white, white, a))     # Alpha8 của UnityPy đọc kênh A của ảnh RGBA
    return new_raw, out, added, fail

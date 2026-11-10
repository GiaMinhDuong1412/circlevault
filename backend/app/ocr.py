"""Nhận diện chữ trên ảnh (RapidOCR = mô hình PaddleOCR chạy bằng onnxruntime, không cần mạng, không cần GPU).

- `read(data)`  → các dòng chữ [{x,y,w,h,text,score}] (ảnh dài kiểu webtoon được cắt thành nhiều đoạn).
- `group(lines)` → gom các dòng gần nhau thành từng khung thoại.
- `analyze(data, mode)` → {w, h, blocks:[{box, area, lines, text, bg, fg}]} – `area` là vùng sẽ phủ bản dịch lên.
"""
from __future__ import annotations

import io
import re
import threading

_engine = None
_lock = threading.Lock()
MIN_SCORE = 0.5
TILE = 1.6          # ảnh cao hơn 1,6 × rộng thì cắt đoạn để chữ không bị thu nhỏ quá
OVERLAP = 160       # px chồng lên nhau giữa 2 đoạn


class OcrMissing(RuntimeError):
    pass


def _get():
    global _engine
    if _engine is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as e:   # thiếu thư viện (bản dev chưa pip install)
            raise OcrMissing("Thiếu bộ nhận diện chữ (rapidocr_onnxruntime). Chạy: pip install -r requirements.txt") from e
        _engine = RapidOCR()
    return _engine


def open_image(data: bytes):
    from PIL import Image, ImageOps
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    return im.convert("RGB")


def _ocr_np(arr, dy: int = 0) -> list[dict]:
    with _lock:
        res, _ = _get()(arr)
    out = []
    for box, text, score in res or []:
        text = (text or "").strip()
        if not text or float(score) < MIN_SCORE:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        out.append({"x": float(x0), "y": float(y0) + dy, "w": float(x1 - x0), "h": float(y1 - y0),
                    "text": text, "score": round(float(score), 3)})
    return out


def read(data: bytes, im=None) -> tuple[object, list[dict]]:
    import numpy as np
    im = im or open_image(data)
    w, h = im.size
    if h <= w * TILE:
        return im, _ocr_np(np.asarray(im))
    step = int(w * TILE)
    lines: list[dict] = []
    top = 0
    while top < h:
        bottom = min(h, top + step)
        tile = _ocr_np(np.asarray(im.crop((0, top, w, bottom))), top)
        # đoạn giữa: bỏ dòng nằm trong phần chồng ở trên (đoạn trước đã đọc rồi)
        lo = top + OVERLAP / 2 if top else -1
        hi = bottom - OVERLAP / 2 if bottom < h else h + 1
        lines += [ln for ln in tile if lo <= ln["y"] + ln["h"] / 2 < hi]
        if bottom >= h:
            break
        top = bottom - OVERLAP
    return im, lines


# ------------------------------------------------------------------ gom khung thoại
def _same_block(a: dict, b: dict) -> bool:
    ha, hb = a["h"], b["h"]
    if min(ha, hb) / max(ha, hb) < 0.5:
        return False
    hm = (ha + hb) / 2
    a_x1, b_x1 = a["x"] + a["w"], b["x"] + b["w"]
    a_y1, b_y1 = a["y"] + ha, b["y"] + hb
    v_overlap = min(a_y1, b_y1) - max(a["y"], b["y"])
    if v_overlap > 0.5 * min(ha, hb):                                 # cùng hàng: chữ bị tách đôi
        gap = max(a["x"], b["x"]) - min(a_x1, b_x1)
        return gap < 1.2 * hm
    v_gap = max(a["y"], b["y"]) - min(a_y1, b_y1)
    if v_gap > 0.9 * hm:
        return False
    h_overlap = min(a_x1, b_x1) - max(a["x"], b["x"])
    ca, cb = a["x"] + a["w"] / 2, b["x"] + b["w"] / 2
    return h_overlap > 0 or abs(ca - cb) < 0.5 * max(a["w"], b["w"])


def _join(lines: list[dict]) -> str:
    rows: list[list[dict]] = []
    for ln in sorted(lines, key=lambda l: l["y"] + l["h"] / 2):
        if rows and abs((rows[-1][0]["y"] + rows[-1][0]["h"] / 2) - (ln["y"] + ln["h"] / 2)) < 0.5 * ln["h"]:
            rows[-1].append(ln)
        else:
            rows.append([ln])
    text = ""
    for r in rows:
        part = " ".join(l["text"] for l in sorted(r, key=lambda l: l["x"]))
        if text.endswith("-") and len(text) > 1 and text[-2].isalpha() and part[:1].isalpha():
            text = text[:-1] + part                                   # WON- / DERFUL
        else:
            text = (text + " " + part).strip()
    return re.sub(r"\s+", " ", text)


def group(lines: list[dict]) -> list[dict]:
    n = len(lines)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if _same_block(lines[i], lines[j]):
                parent[find(i)] = find(j)
    groups: dict[int, list[dict]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(lines[i])
    blocks = []
    for g in groups.values():
        x0 = min(l["x"] for l in g)
        y0 = min(l["y"] for l in g)
        x1 = max(l["x"] + l["w"] for l in g)
        y1 = max(l["y"] + l["h"] for l in g)
        blocks.append({"box": [x0, y0, x1 - x0, y1 - y0], "lines": [[l["x"], l["y"], l["w"], l["h"]] for l in g],
                       "text": _join(g), "lh": sum(l["h"] for l in g) / len(g)})
    blocks.sort(key=lambda b: (round(b["box"][1] / 40), -b["box"][0] - b["box"][2]))  # trên xuống; cùng hàng: phải sang trái (manga)
    return blocks


def _junk(text: str) -> bool:
    letters = sum(c.isalpha() for c in text)
    return letters < 2 and not re.search(r"[!?]", text)


# ------------------------------------------------------------------ màu nền
def _colors(im, box):
    """Màu nền phổ biến nhất quanh khung chữ + màu chữ tương phản."""
    import numpy as np
    x, y, w, h = box
    pad = max(4, int(min(w, h) * 0.15))
    crop = im.crop((max(0, int(x - pad)), max(0, int(y - pad)), min(im.width, int(x + w + pad)), min(im.height, int(y + h + pad))))
    arr = np.asarray(crop).reshape(-1, 3) // 32
    if not len(arr):
        return "#ffffff", "#111111"
    keys = arr[:, 0] * 64 + arr[:, 1] * 8 + arr[:, 2]
    k = int(np.bincount(keys).argmax())
    sel = np.asarray(crop).reshape(-1, 3)[keys == k]
    r, g, b = (int(v) for v in sel.mean(axis=0))
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    return f"#{r:02x}{g:02x}{b:02x}", ("#111111" if lum > 140 else "#ffffff")


def analyze(data: bytes, mode: str = "comic") -> dict:
    im, lines = read(data)
    blocks = [b for b in group(lines) if not _junk(b["text"])]
    out = []
    for b in blocks:
        x, y, w, h = b["box"]
        bg, fg = _colors(im, b["box"])
        ex, ey = w * 0.12 + b["lh"] * 0.3, h * 0.08 + b["lh"] * 0.15   # bản dịch tiếng Việt thường dài hơn
        ax0, ay0 = max(0.0, x - ex), max(0.0, y - ey)
        ax1, ay1 = min(float(im.width), x + w + ex), min(float(im.height), y + h + ey)
        out.append({"box": [round(v, 1) for v in b["box"]], "area": [round(ax0, 1), round(ay0, 1), round(ax1 - ax0, 1), round(ay1 - ay0, 1)],
                    "lines": [[round(v, 1) for v in ln] for ln in b["lines"]], "lh": round(b["lh"], 1),
                    "text": b["text"], "bg": bg, "fg": fg})
    if mode == "game":     # game: đọc theo thứ tự trái → phải, trên → dưới
        out.sort(key=lambda b: (round(b["box"][1] / 20), b["box"][0]))
    return {"w": im.width, "h": im.height, "blocks": out}

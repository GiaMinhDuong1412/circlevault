"""Việt hóa game Unreal Engine (UE4 / UE5) theo cách cộng đồng mod hay làm:

1. Chữ của game nằm trong bảng `.locres` ở `<Dự án>/Content/Localization/<Target>/<ngôn ngữ>/<Target>.locres`, thường đóng
   trong file `.pak` (Content/Paks). App đọc .pak (phiên bản 3 → 11, như UnrealPak / repak), lấy .locres của ngôn ngữ gốc
   (ưu tiên tiếng Anh). Pak nén zlib/gzip đọc được; pak mã hóa AES thì cần khóa AES của game (người dùng nhập); nén Oodle chưa đọc được.
2. Dịch các chuỗi (giữ nguyên khóa và mã băm nguồn để game vẫn nhận).
3. Áp dụng = tạo file mod `Content/Paks/~mods/zz_CircleVault_VI_P.pak` chứa .locres đã dịch, đúng đường dẫn gốc (đuôi `_P` =
   bản vá, được ưu tiên hơn pak gốc). KHÔNG sửa pak gốc của game. Khôi phục = xóa file mod đó. .locres để rời (không trong pak)
   thì ghi đè tại chỗ, bản gốc sao lưu ở `CircleVault-ban-goc/`.
Định dạng theo mã nguồn repak (trumank/repak) và UnrealLocres (akintos/UnrealLocres).
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import io
import re
import struct
import zlib
from pathlib import Path

MAGIC = 0x5A6F12E1
LOCRES_MAGIC = bytes([0x0E, 0x14, 0x74, 0x75, 0x67, 0x4A, 0x03, 0xFC, 0x4A, 0x15, 0x90, 0x9D, 0xC3, 0x37, 0x7F, 0x1B])
MOD_NAME = "zz_CircleVault_VI_P.pak"
# phiên bản đầy đủ: (tên, số ghi trong file, số tên kiểu nén ở footer)
VERSIONS = [("V11", 11, 5), ("V10", 10, 5), ("V9", 9, 5), ("V8B", 8, 5), ("V8A", 8, 4), ("V7", 7, 0), ("V6", 6, 0), ("V5", 5, 0),
            ("V4", 4, 0), ("V3", 3, 0), ("V2", 2, 0), ("V1", 1, 0)]


class UEError(RuntimeError):
    pass


# ------------------------------------------------------------------ đọc nhị phân
class R:
    def __init__(self, b: bytes, pos: int = 0):
        self.b, self.p = b, pos

    def take(self, n: int) -> bytes:
        if n < 0 or self.p + n > len(self.b):
            raise UEError("Dữ liệu pak bị cụt hoặc sai định dạng.")
        v = self.b[self.p:self.p + n]
        self.p += n
        return v

    def u8(self): return self.take(1)[0]
    def u32(self): return struct.unpack("<I", self.take(4))[0]
    def i32(self): return struct.unpack("<i", self.take(4))[0]
    def u64(self): return struct.unpack("<Q", self.take(8))[0]
    def i64(self): return struct.unpack("<q", self.take(8))[0]

    def fstr(self) -> str:
        n = self.i32()
        if n == 0:
            return ""
        if n < 0:
            return self.take(-n * 2).decode("utf-16-le", "replace").rstrip("\x00")
        return self.take(n).decode("latin-1").rstrip("\x00")


def w_fstr(s: str) -> bytes:
    s0 = s + "\x00"
    try:
        b = s0.encode("ascii")
        return struct.pack("<i", len(b)) + b
    except UnicodeEncodeError:
        b = s0.encode("utf-16-le")
        return struct.pack("<i", -(len(b) // 2)) + b


# ------------------------------------------------------------------ khóa AES
def parse_key(key: str | None) -> bytes | None:
    if not key or not key.strip():
        return None
    k = key.strip()
    try:
        if re.fullmatch(r"(0x)?[0-9a-fA-F]{64}", k):
            raw = bytes.fromhex(k[2:] if k.lower().startswith("0x") else k)
        else:
            raw = base64.b64decode(k, validate=True)
    except ValueError as e:
        raise UEError("Khóa AES không đúng dạng (cần 64 ký tự hex 0x… hoặc base64).") from e
    if len(raw) != 32:
        raise UEError("Khóa AES phải dài 32 byte (64 ký tự hex).")
    return raw


def _aes(key: bytes | None, data: bytes) -> bytes:
    if not key:
        raise UEError("Pak này được mã hóa AES. Nhập khóa AES của game (cộng đồng mod thường chia sẻ) rồi tìm lại.")
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except ImportError as e:
        raise UEError("Thiếu thư viện cryptography để giải mã pak.") from e
    d = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    pad = (-len(data)) % 16
    return d.update(data + b"\x00" * pad) + d.finalize()


# ------------------------------------------------------------------ pak
class Entry:
    __slots__ = ("offset", "size", "usize", "comp", "blocks", "encrypted", "block_size", "hash")

    def __init__(self):
        self.offset = self.size = self.usize = 0
        self.comp = None          # chỉ số kiểu nén (0-based) hoặc None
        self.blocks = None        # [(start, end)]
        self.encrypted = False
        self.block_size = 0
        self.hash = b"\x00" * 20


def _entry_size(major: int, vname: str, comp, nblocks: int) -> int:
    size = 8 + 8 + 8 + (1 if vname == "V8A" else 4) + (8 if major == 1 else 0) + 20
    if comp is not None:
        size += 4 + 16 * nblocks
    size += 1
    if major >= 3:
        size += 4
    return size


def _read_entry(r: R, major: int, vname: str) -> Entry:
    e = Entry()
    e.offset, e.size, e.usize = r.u64(), r.u64(), r.u64()
    c = r.u8() if vname == "V8A" else r.u32()
    e.comp = None if c == 0 else c - 1
    if major == 1:
        r.u64()
    e.hash = r.take(20)
    if major >= 3:
        if e.comp is not None:
            e.blocks = [(r.u64(), r.u64()) for _ in range(r.u32())]
        e.encrypted = bool(r.u8() & 1)
        e.block_size = r.u32()
    return e


def _read_encoded(r: R, major: int, vname: str) -> Entry:
    bits = r.u32()
    e = Entry()
    c = (bits >> 23) & 0x3F
    e.comp = None if c == 0 else c - 1
    e.encrypted = bool(bits & (1 << 22))
    nblocks = (bits >> 6) & 0xFFFF
    bs = bits & 0x3F
    e.block_size = r.u32() if bs == 0x3F else bs << 11
    e.offset = r.u32() if bits & (1 << 31) else r.u64()
    e.usize = r.u32() if bits & (1 << 30) else r.u64()
    e.size = e.usize if e.comp is None else (r.u32() if bits & (1 << 29) else r.u64())
    base = _entry_size(major, vname, e.comp, nblocks)
    if nblocks == 1 and not e.encrypted:
        e.blocks = [(base, base + e.size)]
    elif nblocks > 0:
        e.blocks, idx = [], base
        for _ in range(nblocks):
            sz = r.u32()
            e.blocks.append((idx, idx + sz))
            idx += (sz + 15) & ~15 if e.encrypted else sz
    return e


class Pak:
    def __init__(self, path: Path, key: bytes | None = None):
        self.path = Path(path)
        self.key = key
        data_len = self.path.stat().st_size
        with open(self.path, "rb") as f:
            f.seek(max(0, data_len - 300))
            tail = f.read()
            self._load(f, data_len, tail)

    def _load(self, f, size: int, tail: bytes):
        last = None
        for vname, major, ncomp in VERSIONS:
            fsize = 44 + (16 if major >= 7 else 0) + (1 if major >= 4 else 0) + (1 if major == 9 else 0) + 32 * ncomp
            if fsize > len(tail):
                continue
            r = R(tail, len(tail) - fsize)
            try:
                if major >= 7:
                    r.take(16)
                enc = bool(r.u8()) if major >= 4 else False
                if r.u32() != MAGIC or r.u32() != major:
                    continue
                ioff, isize = r.u64(), r.u64()
                r.take(20)
                if major == 9:
                    r.u8()
                comps = [r.take(32).split(b"\x00", 1)[0].decode("ascii", "replace") or None for _ in range(ncomp)]
                if major < 8:
                    comps = ["Zlib", "Gzip", "Oodle"]
                if ioff + isize > size:
                    continue
                self.vname, self.major, self.ncomp, self.comps, self.encrypted_index = vname, major, ncomp, comps, enc
                f.seek(ioff)
                idx = f.read(isize)
                if enc:
                    idx = _aes(self.key, idx)[:isize]
                self._index(f, idx)
                return
            except UEError as e:
                last = e
                if "AES" in str(e):
                    raise
                continue
        raise last or UEError(f"Không đọc được {self.path.name} (không phải pak Unreal hoặc phiên bản lạ).")

    def _index(self, f, idx: bytes):
        r = R(idx)
        self.mount = r.fstr()
        count = r.u32()
        self.entries: dict[str, Entry] = {}
        if self.major < 10:
            for _ in range(count):
                name = r.fstr()
                self.entries[name] = _read_entry(r, self.major, self.vname)
            return
        r.u64()                                          # path hash seed
        if r.u32():
            r.u64(), r.u64(), r.take(20)                 # path hash index (không cần)
        fdi = None
        if r.u32():
            off, sz = r.u64(), r.u64()
            r.take(20)
            f.seek(off)
            fdi = f.read(sz)
            if self.encrypted_index:
                fdi = _aes(self.key, fdi)[:sz]
        enc_entries = r.take(r.u32())
        plain = [_read_entry(r, self.major, self.vname) for _ in range(r.u32())]
        if fdi is None:
            raise UEError("Pak không có danh mục tên file (đã bị lược bỏ) – chưa đọc được.")
        d = R(fdi)
        for _ in range(d.u32()):
            dname = d.fstr()
            for _ in range(d.u32()):
                fname, off = d.fstr(), d.i32()
                if off == -2147483648:
                    continue
                e = _read_encoded(R(enc_entries, off), self.major, self.vname) if off >= 0 else plain[-off - 1]
                self.entries[(dname[1:] if dname.startswith("/") else dname) + fname] = e

    def full_path(self, name: str) -> str:
        return (self.mount + name).replace("\\", "/")

    def read(self, name: str) -> bytes:
        e = self.entries[name]
        with open(self.path, "rb") as f:
            f.seek(e.offset)
            head = f.read(_entry_size(self.major, self.vname, e.comp, len(e.blocks or [])))
            data_start = e.offset + len(head)
            need = (e.size + 15) & ~15 if e.encrypted else e.size
            data = f.read(need)
        if e.encrypted:
            data = _aes(self.key, data)[:e.size]
        if e.comp is None:
            return data[:e.usize] if e.usize else data
        method = (self.comps[e.comp] if e.comp < len(self.comps) else None) or "?"
        out = bytearray()
        blocks = e.blocks or [(0, e.size)]
        for start, end in blocks:
            if self.major >= 5:
                a, b = start - (data_start - e.offset), end - (data_start - e.offset)
            else:
                a, b = start - data_start, end - data_start
            chunk = data[a:b]
            m = method.lower()
            if m == "zlib":
                out += zlib.decompress(chunk)
            elif m == "gzip":
                out += gzip.decompress(chunk)
            elif m == "lz4":
                import lz4.block
                out += lz4.block.decompress(chunk, uncompressed_size=min(e.block_size or e.usize, e.usize - len(out)))
            else:
                raise UEError(f"Pak nén kiểu {method} (thường là Oodle) – app chưa giải nén được.")
        return bytes(out)


def write_pak(files: dict[str, bytes], mount: str, vname: str) -> bytes:
    """Pak không nén, không mã hóa, cùng phiên bản với pak gốc của game."""
    info = next((v for v in VERSIONS if v[0] == vname), VERSIONS[3])
    vname, major, ncomp = info
    if major < 3:
        vname, major, ncomp = "V3", 3, 0
    buf = io.BytesIO()
    recs = []
    for name in sorted(files):
        data = files[name]
        h = hashlib.sha1(data).digest()
        off = buf.tell()
        buf.write(_entry_bytes(major, vname, 0, len(data), h))
        buf.write(data)
        recs.append((name, off, len(data), h))
    ioff = buf.tell()
    idx = io.BytesIO()
    idx.write(w_fstr(mount))
    idx.write(struct.pack("<I", len(recs)))
    if major < 10:
        for name, off, n, h in recs:
            idx.write(w_fstr(name))
            idx.write(_entry_bytes(major, vname, off, n, h))
        index = idx.getvalue()
        buf.write(index)
        tail = b""
    else:
        seed = 0
        enc = io.BytesIO()
        offsets = []
        for name, off, n, h in recs:
            offsets.append(enc.tell())
            flags = (1 << 29) | (1 << 30) | (1 << 31) if off <= 0xFFFFFFFF and n <= 0xFFFFFFFF else 0
            enc.write(struct.pack("<I", flags))
            enc.write(struct.pack("<I", off) if flags else struct.pack("<Q", off))
            enc.write(struct.pack("<I", n) if flags else struct.pack("<Q", n))
        enc_b = enc.getvalue()
        phi = io.BytesIO()
        phi.write(struct.pack("<I", len(recs)))
        for (name, *_), o in zip(recs, offsets):
            phi.write(struct.pack("<QI", _fnv64_path(name, seed), o))
        phi.write(struct.pack("<I", 0))
        dirs: dict[str, dict[str, int]] = {}
        for (name, *_), o in zip(recs, offsets):
            p = name
            while True:
                sp = _split(p)
                if not sp:
                    break
                p = sp[0]
                dirs.setdefault(p, {})
            dname, fname = _split(name)
            dirs.setdefault(dname, {})[fname] = o
        fdi = io.BytesIO()
        fdi.write(struct.pack("<I", len(dirs)))
        for dname in sorted(dirs):
            fdi.write(w_fstr(dname))
            fdi.write(struct.pack("<I", len(dirs[dname])))
            for fname in sorted(dirs[dname]):
                fdi.write(w_fstr(fname) + struct.pack("<I", dirs[dname][fname]))
        phi_b, fdi_b = phi.getvalue(), fdi.getvalue()
        head = idx.getvalue() + struct.pack("<Q", seed)
        before = len(head) + 4 + 8 + 8 + 20 + 4 + 8 + 8 + 20 + 4 + len(enc_b) + 4
        phi_off = ioff + before
        fdi_off = phi_off + len(phi_b)
        index = (head + struct.pack("<IQQ", 1, phi_off, len(phi_b)) + hashlib.sha1(phi_b).digest()
                 + struct.pack("<IQQ", 1, fdi_off, len(fdi_b)) + hashlib.sha1(fdi_b).digest()
                 + struct.pack("<I", len(enc_b)) + enc_b + struct.pack("<I", 0))
        buf.write(index)
        tail = phi_b + fdi_b
        buf.write(tail)
    footer = b""
    if major >= 7:
        footer += b"\x00" * 16
    if major >= 4:
        footer += b"\x00"
    footer += struct.pack("<IIQQ", MAGIC, major, ioff, len(index)) + hashlib.sha1(index).digest()
    if major == 9:
        footer += b"\x00"
    footer += b"\x00" * 32 * ncomp
    buf.write(footer)
    return buf.getvalue()


def _entry_bytes(major: int, vname: str, off: int, n: int, h: bytes) -> bytes:
    b = struct.pack("<QQQ", off, n, n) + (b"\x00" if vname == "V8A" else b"\x00\x00\x00\x00")
    if major == 1:
        b += b"\x00" * 8
    b += h
    if major >= 3:
        b += b"\x00" + struct.pack("<I", 0)
    return b


def _fnv64_path(path: str, seed: int) -> int:
    h = (0xCBF29CE484222325 + seed) & 0xFFFFFFFFFFFFFFFF
    for byte in path.lower().encode("utf-16-le"):
        h ^= byte
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h


def _split(path: str):
    if path in ("/", ""):
        return None
    p = path[:-1] if path.endswith("/") else path
    i = p.rfind("/")
    return (p[:i + 1], p[i + 1:]) if i >= 0 else ("/", p)


# ------------------------------------------------------------------ locres
def locres_read(b: bytes) -> dict:
    r = R(b)
    if b[:16] == LOCRES_MAGIC:
        r.take(16)
        ver = r.u8()
    else:
        ver = 0
    table, table_off = None, None
    if ver >= 1:
        table_off = r.i64()
        save = r.p
        r.p = table_off
        n = r.i32()
        table = []
        for _ in range(n):
            table.append(r.fstr())
            if ver >= 2:
                r.i32()
        r.p = save
    if ver >= 2:
        r.i32()
    rows = []
    for _ in range(r.i32()):
        if ver >= 2:
            r.u32()
        ns = r.fstr()
        for _ in range(r.i32()):
            if ver >= 2:
                r.u32()
            key = r.fstr()
            r.u32()
            if ver >= 1:
                i = r.i32()
                rows.append((ns, key, table[i] if 0 <= i < len(table) else "", i))
            else:
                rows.append((ns, key, r.fstr(), None))
    if ver > 3:
        raise UEError(f"Bảng chữ .locres phiên bản {ver} chưa hỗ trợ.")
    return {"version": ver, "rows": rows, "table": table, "table_off": table_off}


def locres_write(b: bytes, tr: dict[str, str]) -> tuple[bytes, int]:
    """Thay chữ, giữ nguyên khóa + mã băm (game vẫn khớp bảng). Bản Compact+: chỉ viết lại bảng chuỗi ở cuối file."""
    info = locres_read(b)
    n = 0
    if info["version"] >= 1:
        out = bytearray(b[:info["table_off"]])
        out += struct.pack("<i", len(info["table"]))
        # đếm lại số lần dùng (refcount) như file gốc
        refs: dict[int, int] = {}
        for *_, i in info["rows"]:
            refs[i] = refs.get(i, 0) + 1
        for i, t in enumerate(info["table"]):
            v = tr.get(t)
            if v and v != t:
                n += 1
            out += w_fstr(v or t)
            if info["version"] >= 2:
                out += struct.pack("<i", refs.get(i, 1))
        return bytes(out), n
    # bản cũ (Legacy): chuỗi nằm ngay sau khóa → viết lại cả file
    r = R(b)
    out = bytearray(struct.pack("<i", r.i32()))
    for _ in range(struct.unpack("<i", out[:4])[0]):
        ns_start = r.p
        r.fstr()
        out += b[ns_start:r.p]
        cnt = r.i32()
        out += struct.pack("<i", cnt)
        for _ in range(cnt):
            k0 = r.p
            r.fstr()
            r.u32()
            out += b[k0:r.p]
            t = r.fstr()
            v = tr.get(t)
            if v and v != t:
                n += 1
            out += w_fstr(v or t)
    return bytes(out), n


# ------------------------------------------------------------------ tìm bảng chữ trong game
CULTURE = re.compile(r"(?i)/Localization/([^/]+)/([^/]+)/[^/]+\.locres$")


def game_dirs(root: Path) -> list[Path]:
    """Các thư mục <Dự án> có Content/Paks (UE đặt game ở <thư mục cài>/<Dự án>/Content/Paks)."""
    out = []
    for d in [root, *[x for x in root.iterdir() if x.is_dir()]]:
        if (d / "Content" / "Paks").is_dir():
            out.append(d)
    return out


def find_locres(root: Path, key: bytes | None) -> tuple[list[dict], list[str]]:
    """Mọi .locres trong pak + để rời: [{where: 'pak'|'loose', pak, name, full, target, culture}], cảnh báo."""
    found, warns = [], []
    for gd in game_dirs(root):
        for p in sorted((gd / "Content" / "Paks").rglob("*.pak")):
            if p.name == MOD_NAME:
                continue
            try:
                pak = Pak(p, key)
            except UEError as e:
                warns.append(f"{p.name}: {e}")
                continue
            except (OSError, struct.error, ValueError) as e:
                warns.append(f"{p.name}: {e}")
                continue
            for name in pak.entries:
                full = pak.full_path(name)
                m = CULTURE.search("/" + full)
                if m and "/Engine/" not in "/" + full:
                    found.append({"where": "pak", "pak": str(p.relative_to(root)).replace("\\", "/"), "name": name, "full": full,
                                  "target": m.group(1), "culture": m.group(2), "version": pak.vname, "mount": pak.mount,
                                  "enc": pak.encrypted_index})
        loc = gd / "Content" / "Localization"
        if loc.is_dir():
            for f in loc.rglob("*.locres"):
                rel = str(f.relative_to(root)).replace("\\", "/")
                m = CULTURE.search("/" + rel)
                if m:
                    found.append({"where": "loose", "rel": rel, "target": m.group(1), "culture": m.group(2)})
    return found, warns


def pick_culture(found: list[dict], prefer: str = "en") -> str | None:
    cultures = {f["culture"] for f in found}
    for c in (prefer, f"{prefer}-US", f"{prefer}-GB", "en", "en-US", "en-GB"):
        for x in cultures:
            if x.lower() == c.lower():
                return x
    return sorted(cultures)[0] if cultures else None


def read_locres(root: Path, src: dict, key: bytes | None) -> bytes:
    if src["where"] == "pak":
        return Pak(root / src["pak"], key).read(src["name"])
    b = root / "CircleVault-ban-goc" / src["rel"]
    return (b if b.is_file() else root / src["rel"]).read_bytes()


def apply(root: Path, final: list[dict], sources: list[dict], key: bytes | None) -> dict:
    tr = {it["t"]: it["final"] for it in final if it.get("final") and it["final"] != it["t"]}
    mods: dict[str, dict] = {}
    texts = files = 0
    for s in sources:
        orig = read_locres(root, s, key)
        new, n = locres_write(orig, tr)
        if not n:
            continue
        texts += n
        if s["where"] == "loose":
            p = root / s["rel"]
            b = root / "CircleVault-ban-goc" / s["rel"]
            if not b.exists():
                b.parent.mkdir(parents=True, exist_ok=True)
                b.write_bytes(orig)
            p.write_bytes(new)
            files += 1
            continue
        gd = Path(s["pak"]).parts[0] if "/Content/Paks" in "/" + s["pak"] else ""
        mods.setdefault(gd, {"version": s["version"], "files": {}})["files"][s["full"]] = new
    for gd, m in mods.items():
        common = "../../../"
        files_map = {}
        for full, data in m["files"].items():
            name = full[len(common):] if full.startswith(common) else full.lstrip("/")
            files_map[name] = data
        out = root / gd / "Content" / "Paks" / "~mods" / MOD_NAME if gd else root / "Content" / "Paks" / "~mods" / MOD_NAME
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(write_pak(files_map, common, m["version"]))
        files += 1
    return {"texts": texts, "files": files}


def restore(root: Path, sources: list[dict]) -> int:
    n = 0
    for gd in game_dirs(root):
        f = gd / "Content" / "Paks" / "~mods" / MOD_NAME
        if f.is_file():
            f.unlink()
            n += 1
    for s in sources:
        if s["where"] == "loose":
            b = root / "CircleVault-ban-goc" / s["rel"]
            if b.is_file():
                (root / s["rel"]).write_bytes(b.read_bytes())
                n += 1
    return n


def texts_of(b: bytes) -> list[tuple[str, str]]:
    """(chữ, ngữ cảnh namespace/khóa) – bỏ chuỗi rỗng / trùng."""
    seen, out = set(), []
    for ns, key, text, _ in locres_read(b)["rows"]:
        if text and text.strip() and text not in seen:
            seen.add(text)
            out.append((text, f"{ns}/{key}" if ns else key))
    return out

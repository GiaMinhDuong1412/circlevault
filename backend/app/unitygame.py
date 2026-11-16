"""Game Unity (Steam…) – hai việc:

1. Việt hóa từ file cho game dùng **Unity Localization** (bảng chữ nằm trong Addressables bundle
   `<Game>_Data/StreamingAssets/aa/**/localization-string-tables-<ngôn ngữ>_*.bundle`): đọc bảng của ngôn ngữ gốc
   (thường tiếng Anh) bằng UnityPy, dịch, ghi đè chữ vào chính bảng đó (game không có tiếng Việt nên thay chỗ tiếng Anh –
   cách các nhóm Việt hóa vẫn làm), rồi tắt kiểm tra CRC của bundle trong `catalog.json` (Addressables từ chối bundle
   bị sửa nếu CRC lệch). Bản gốc sao lưu ở `<game>/CircleVault-ban-goc/`, áp dụng lại luôn đọc từ bản sao lưu.
2. Cài **gói Việt hóa có sẵn** (file .zip hoặc thư mục của nhóm dịch, kiểu "chép đè vào thư mục game"): tự tìm đúng chỗ
   đặt file, sao lưu file sắp bị đè vào `<game>/CircleVault-truoc-VH/<mã>/`, gỡ được, và nhận ra khi Steam cập nhật game
   ghi đè mất bản Việt hóa (so kích thước + thời gian sửa) để cài lại.

Kèm danh sách game Steam đã cài (đọc libraryfolders.vdf + appmanifest_*.acf) để chọn nhanh thư mục game.
Không vượt mã hóa / chống chỉnh sửa của game.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import struct
import sys
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import config, translate, unityload

BACKUP_DIR = "CircleVault-ban-goc"
PATCH_BACKUP = "CircleVault-truoc-VH"
PATCHES = config.DATA / "translate" / "patches"
STRING_TABLE = re.compile(r"string[-_ ]?tables?", re.I)


class GameError(RuntimeError):
    pass


# ================================================================== nhận diện
def unity_root(path: Path) -> Path | None:
    """Thư mục gốc game Unity (chứa <Tên>_Data và file .exe), nhận cả khi người dùng chọn thư mục _Data."""
    for root in (path, path.parent):
        if root.is_dir() and any(d.is_dir() and d.name.endswith("_Data") for d in root.iterdir()):
            return root
    return None


def data_dirs(root: Path) -> list[Path]:
    return sorted(d for d in root.iterdir() if d.is_dir() and d.name.endswith("_Data") and (d / "StreamingAssets").is_dir()) \
        or sorted(d for d in root.iterdir() if d.is_dir() and d.name.endswith("_Data"))


def _src(root: Path, p: Path) -> Path:
    """File gốc để đọc: bản sao lưu nếu đã áp dụng trước đó (hoặc bản trước khi cài gói Việt hóa của nhóm dịch)."""
    rel = p.relative_to(root)
    b = root / BACKUP_DIR / rel
    if b.exists():
        return b
    vh = root / PATCH_BACKUP
    if vh.is_dir():
        for d in sorted(vh.iterdir()):
            if (d / rel).is_file():
                return d / rel
    return p


def _backup(root: Path, p: Path):
    b = root / BACKUP_DIR / p.relative_to(root)
    if not b.exists():
        b.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_src(root, p), b)


def _unitypy():
    try:
        import UnityPy  # noqa: N813 – nặng, chỉ nạp khi cần
    except ImportError as e:
        raise GameError("Thiếu thư viện UnityPy để đọc game Unity. Cập nhật app bản mới nhất.") from e
    return UnityPy


def string_bundles(root: Path) -> list[Path]:
    out: list[Path] = []
    for data in data_dirs(root):
        aa = data / "StreamingAssets" / "aa"
        if aa.is_dir():
            out += [p for p in aa.rglob("*.bundle") if STRING_TABLE.search(p.name)]
    return sorted(out)


def _locale_tables(env):
    """(obj, tree) của mọi StringTable trong bundle."""
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:      # MonoBehaviour không có typetree (script khác) – bỏ qua
            continue
        if isinstance(tree, dict) and isinstance(tree.get("m_TableData"), list) and isinstance(tree.get("m_LocaleId"), dict):
            yield obj, tree


def _code_of(name: str) -> str | None:
    m = re.search(r"\(([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\)_", name)
    return m.group(1).lower() if m else None


def pick_bundles(root: Path) -> tuple[str, list[Path]]:
    """Chọn ngôn ngữ gốc để thay (ưu tiên tiếng Anh) và các bundle bảng chữ của ngôn ngữ đó."""
    bundles = string_bundles(root)
    if not bundles:
        return "", []
    by: dict[str, list[Path]] = {}
    for b in bundles:
        code = _code_of(b.name) or ("en" if "english" in b.name.lower() else None)
        by.setdefault(code or "?", []).append(b)
    for code in ("en", "en-us", "en-gb"):
        if code in by:
            return code, by[code]
    if "?" in by:                               # tên bundle không có mã ngôn ngữ: đọc thử
        found: dict[str, list[Path]] = {}
        for b in by["?"]:
            with unityload.open_env(_src(root, b)) as env:
                for _o, t in _locale_tables(env):
                    found.setdefault(str(t["m_LocaleId"].get("m_Code", "")).lower(), []).append(b)
        for code in ("en", "en-us", "en-gb"):
            if code in found:
                return code, sorted(set(found[code]))
        if found:
            code = max(found, key=lambda c: len(found[c]))
            return code, sorted(set(found[code]))
    code = max(by, key=lambda c: len(by[c]))
    return code, by[code]


def catalog_of(root: Path) -> Path | None:
    for data in data_dirs(root):
        for name in ("catalog.json", "catalog.bin"):
            p = data / "StreamingAssets" / "aa" / name
            if p.exists():
                return p
    return None


def is_localization_game(path: Path) -> Path | None:
    root = unity_root(path)
    return root if root and string_bundles(root) else None


# ================================================================== đọc chữ
def scan(root: Path) -> tuple[list[dict], dict]:
    _unitypy()
    code, bundles = pick_bundles(root)
    if not bundles:
        raise GameError("Game Unity này không dùng Unity Localization (không có bundle bảng chữ trong StreamingAssets/aa). "
                        "Nếu có gói Việt hóa của nhóm dịch, dùng mục 'Cài gói Việt hóa có sẵn'; không thì dùng Dịch màn hình game.")
    items, errors = [], []
    for b in bundles:
        try:
            with unityload.open_env(_src(root, b)) as env:
                for _obj, t in _locale_tables(env):
                    if str(t["m_LocaleId"].get("m_Code", "")).lower() != code:
                        continue
                    name = re.sub(r"_[A-Za-z-]+$", "", str(t.get("m_Name") or ""))
                    for e in t["m_TableData"]:
                        s = e.get("m_Localized")
                        if isinstance(s, str) and s.strip():
                            items.append({"t": s, "kind": "ui", "ctx": name})
        except Exception as e:      # bundle hỏng / mã hóa
            errors.append(f"{b.name}: {e}")
    cat = catalog_of(root)
    info = {"errors": errors, "unity": {"locale": code, "bundles": [str(b.relative_to(root)) for b in bundles],
                                        "catalog": str(cat.relative_to(root)) if cat else None}}
    if cat and cat.suffix == ".bin":
        info["errors"].append("Game dùng catalog.bin: app tìm mã CRC của từng bundle trong đó để tắt; bundle nào không tìm được thì giữ bản gốc.")
    return items, info


# ================================================================== ghi chữ + tắt CRC
def apply(root: Path, items: list[dict], unity: dict, prog=None) -> dict:
    prog = prog or (lambda *a: None)
    _unitypy()
    tr = {it["t"]: it["final"] for it in items if it.get("final") and it["final"] != it["t"]}
    code = unity.get("locale") or "en"
    changed, files, names, errors = 0, 0, [], []
    for k, rel in enumerate(unity.get("bundles") or []):
        prog(f"Đang ghi bảng chữ {Path(rel).name}", k, len(unity.get("bundles") or []))
        p = root / rel
        if not p.exists():
            continue
        _backup(root, p)
        n = 0
        with unityload.open_env(_src(root, p)) as env:     # đọc bản sao lưu, đóng file xong mới ghi đè file game
            for obj, t in _locale_tables(env):
                if str(t["m_LocaleId"].get("m_Code", "")).lower() != code:
                    continue
                hit = 0
                for e in t["m_TableData"]:
                    v = tr.get(e.get("m_Localized"))
                    if v:
                        e["m_Localized"] = v
                        hit += 1
                if hit:
                    obj.save_typetree(t)
                    n += hit
            data = next(iter(env.files.values())).save(packer="lz4") if n else b""
        if not n:
            continue
        if not crc_off(root, p):                # không tắt được kiểm tra CRC: ghi vào là game đứng lúc tải → bỏ qua
            errors.append(f"{p.name}: không tắt được kiểm tra CRC của game nên giữ bản gốc (để game không bị đứng).")
            continue
        config.write_file(p, data)
        changed += n
        files += 1
        names.append(p.name)
    return {"texts": changed, "files": files, "crc_off": len(names), "errors": errors}


def zero_crc(catalog_text: str, bundle_names: list[str]) -> tuple[str, int]:
    """Đặt m_Crc = 0 cho các bundle đã sửa trong catalog.json của Addressables.

    m_ExtraDataString là base64 của dãy đối tượng; AssetBundleRequestOptions lưu dạng JSON UTF-16. Để không phải dựng lại
    toàn bộ (và mọi vị trí trong m_EntryDataString), giữ nguyên độ dài: thay số CRC bằng 0 rồi bù dấu cách (JSON hợp lệ)."""
    j = json.loads(catalog_text)
    ids = j.get("m_InternalIds") or []
    entry = base64.b64decode(j["m_EntryDataString"])
    extra = bytearray(base64.b64decode(j["m_ExtraDataString"]))
    want = {n.lower() for n in bundle_names}
    count = struct.unpack_from("<i", entry, 0)[0]
    done = 0
    for e in range(count):
        iid, _prov, _dep, _dh, data_index, _pk, _rt = struct.unpack_from("<7i", entry, 4 + e * 28)
        if data_index < 0 or not (0 <= iid < len(ids)):
            continue
        name = re.split(r"[\\/]", ids[iid])[-1].lower()
        if name not in want:
            continue
        p = data_index
        if extra[p] != 7:                       # 7 = JsonObject
            continue
        p += 1
        p += 1 + extra[p]                       # tên assembly
        p += 1 + extra[p]                       # tên lớp
        ln = struct.unpack_from("<i", extra, p)[0]
        p += 4
        js = extra[p:p + ln].decode("utf-16-le")
        new = re.sub(r'("m_Crc"\s*:\s*)(\d+)', lambda m: m.group(1) + "0" + " " * (len(m.group(2)) - 1), js, count=1)
        if new != js:
            extra[p:p + ln] = new.encode("utf-16-le")
            done += 1
    j["m_ExtraDataString"] = base64.b64encode(bytes(extra)).decode("ascii")
    return json.dumps(j, ensure_ascii=False, separators=(",", ":")), done


def catalog_crcs(catalog_text: str) -> dict[str, int]:
    """Tên bundle (chữ thường) → m_Crc đang ghi trong catalog.json (đọc như zero_crc)."""
    j = json.loads(catalog_text)
    ids = j.get("m_InternalIds") or []
    entry = base64.b64decode(j["m_EntryDataString"])
    extra = base64.b64decode(j["m_ExtraDataString"])
    out: dict[str, int] = {}
    for e in range(struct.unpack_from("<i", entry, 0)[0]):
        iid, _prov, _dep, _dh, data_index, _pk, _rt = struct.unpack_from("<7i", entry, 4 + e * 28)
        if data_index < 0 or not (0 <= iid < len(ids)) or extra[data_index] != 7:
            continue
        q = data_index + 1
        q += 1 + extra[q]
        q += 1 + extra[q]
        ln = struct.unpack_from("<i", extra, q)[0]
        m = re.search(r'"m_Crc"\s*:\s*(\d+)', extra[q + 4:q + 4 + ln].decode("utf-16-le", "replace"))
        if m:
            out[re.split(r"[\\/]", ids[iid])[-1].lower()] = int(m.group(1))
    return out


def bundle_crc(path: Path) -> int | None:
    """CRC của bundle như Unity tính (CRC32 của phần dữ liệu đã giải nén) – dùng để tìm đúng chỗ trong catalog.bin.
    Tự đọc khung UnityFS (UnityPy không giữ dữ liệu đã giải nén); bundle mã hóa / lạ → None."""
    import zlib
    from UnityPy.helpers.CompressionHelper import DECOMPRESSION_MAP
    d = Path(path).read_bytes()
    try:
        if not d.startswith(b"UnityFS\0"):
            return None
        q = 8
        ver = struct.unpack_from(">I", d, q)[0]
        q += 4
        for _ in range(2):                                # phiên bản player, engine
            q = d.index(b"\0", q) + 1
        _size, csz, usz, flags = struct.unpack_from(">qIII", d, q)
        q += 20
        if ver >= 7:
            q = (q + 15) & ~15
        cmp = flags & 0x3F

        def dec(b: bytes, n: int, c: int) -> bytes:
            return b if c == 0 else bytes(DECOMPRESSION_MAP[c](b, n))
        if flags & 0x80:                                  # blocksInfo ở cuối file
            info = dec(d[len(d) - csz:], usz, cmp)
            start = q
        else:
            info = dec(d[q:q + csz], usz, cmp)
            start = q + csz
        n = struct.unpack_from(">i", info, 16)[0]
        blocks = [struct.unpack_from(">IIH", info, 20 + k * 10) for k in range(n)]
        if any(b[2] & 0x100 for b in blocks):            # khối mã hóa
            return None
        for st in dict.fromkeys((start, (start + 15) & ~15)):   # có bản Unity đệm 16 byte trước dữ liệu
            try:
                crc, pos = 0, st
                for u, c, f in blocks:
                    chunk = dec(d[pos:pos + c], u, f & 0x3F)
                    if len(chunk) != u:
                        raise ValueError("sai kích thước")
                    crc = zlib.crc32(chunk, crc)
                    pos += c
                return crc & 0xFFFFFFFF
            except Exception:
                continue
    except Exception:
        return None
    return None


def crc_off(root: Path, bundle: Path) -> bool:
    """Tắt kiểm tra CRC của Addressables cho một bundle sắp bị sửa. False = không tắt được → KHÔNG được ghi bundle đó
    (Addressables từ chối bundle sai CRC, game đứng ở màn hình tải)."""
    root, bundle = Path(root), Path(bundle)
    cat = catalog_of(root)
    if not cat or not cat.exists():
        return True                                   # không có catalog Addressables: game tự nạp bundle, không kiểm CRC
    if cat.parent not in bundle.parents:
        return True                                   # bundle không thuộc thư mục aa
    _backup(root, cat)
    name = bundle.name.lower()
    if cat.suffix == ".json":
        text = cat.read_text(encoding="utf-8")
        crcs = catalog_crcs(text)
        if crcs.get(name, 0) == 0:
            return True                               # đã là 0 hoặc catalog không nhắc tới bundle này
        text, done = zero_crc(text, [bundle.name])
        if not done:
            return False
        config.write_file(cat, text)
        return True
    crc = bundle_crc(_src(root, bundle))              # catalog.bin: tìm 4 byte CRC gốc của bundle rồi đặt 0
    if not crc:
        return False
    key = struct.pack("<I", crc)
    cur = bytearray(cat.read_bytes())
    hits = [m.start() for m in re.finditer(re.escape(key), bytes(cur))]
    if not hits:                                      # lần áp dụng trước đã đặt 0?
        orig = _src(root, cat).read_bytes()
        at = [m.start() for m in re.finditer(re.escape(key), orig)]
        return bool(at) and len(orig) == len(cur) and all(cur[i:i + 4] == b"\0\0\0\0" for i in at)
    if len(hits) > 2:
        return False
    for i in hits:
        cur[i:i + 4] = b"\0\0\0\0"
    config.write_file(cat, bytes(cur))
    return True


def restore(root: Path) -> int:
    b = root / BACKUP_DIR
    n = 0
    if b.exists():
        for f in b.rglob("*"):
            if f.is_file():
                shutil.copy2(f, root / f.relative_to(b))
                n += 1
    return n


# ================================================================== game Steam đã cài
def _vdf_values(text: str, key: str) -> list[str]:
    return [m.group(1).replace("\\\\", "\\") for m in re.finditer(r'"%s"\s+"((?:[^"\\]|\\.)*)"' % re.escape(key), text, re.I)]


def steam_roots() -> list[Path]:
    roots: list[Path] = []
    if sys.platform == "win32":
        try:
            import winreg
            for hive, sub in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                              (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam")):
                try:
                    with winreg.OpenKey(hive, sub) as k:
                        for name in ("SteamPath", "InstallPath"):
                            try:
                                roots.append(Path(winreg.QueryValueEx(k, name)[0]))
                            except OSError:
                                pass
                except OSError:
                    pass
        except ImportError:
            pass
        roots.append(Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Steam")
    else:
        roots += [Path.home() / ".steam" / "steam", Path.home() / ".local" / "share" / "Steam"]
    libs: list[Path] = []
    for r in roots:
        vdf = r / "steamapps" / "libraryfolders.vdf"
        cands = [r]
        if vdf.exists():
            try:
                cands += [Path(x) for x in _vdf_values(vdf.read_text(encoding="utf-8", errors="replace"), "path")]
            except OSError:
                pass
        for c in cands:
            if (c / "steamapps").is_dir() and all(c.resolve() != x.resolve() for x in libs):
                libs.append(c)
    return libs


def steam_games() -> list[dict]:
    out = []
    for lib in steam_roots():
        for acf in (lib / "steamapps").glob("appmanifest_*.acf"):
            try:
                text = acf.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            name = (_vdf_values(text, "name") or [""])[0]
            inst = (_vdf_values(text, "installdir") or [""])[0]
            path = lib / "steamapps" / "common" / inst
            if not inst or not path.is_dir() or re.search(r"Steamworks|Redistributable|Proton|Steam Linux Runtime", name):
                continue
            kind = "unity" if unity_root(path) else ""
            if not kind and ((path / "www" / "data" / "System.json").exists() or (path / "data" / "System.json").exists()):
                kind = "rpg"
            if not kind and (path / "game").is_dir() and (any((path / "game").glob("*.rpa")) or any((path / "game").glob("*.rpyc"))):
                kind = "renpy"
            out.append({"appid": (_vdf_values(text, "appid") or [""])[0], "name": name or inst, "path": str(path), "kind": kind})
    out.sort(key=lambda g: g["name"].lower())
    return out


# ================================================================== gói Việt hóa có sẵn
KNOWN_ROOT = {"bepinex", "winhttp.dll", "version.dll", "dinput8.dll", "doorstop_config.ini", ".doorstop_version", "melonloader",
              "mods", "userdata", "plugins", "translation", "autotranslator"}
JUNK = re.compile(r"(^|/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(/|$)", re.I)
MAX_PATCH = 20 * 1024**3


def _entries(source: Path) -> list[tuple[str, int]]:
    """(đường dẫn tương đối dùng '/', kích thước) của mọi file trong gói."""
    if source.is_dir():
        return [(f.relative_to(source).as_posix(), f.stat().st_size) for f in source.rglob("*") if f.is_file()]
    if source.suffix.lower() == ".zip" and source.is_file():
        try:
            with zipfile.ZipFile(source) as z:
                return [(i.filename.replace("\\", "/"), i.file_size) for i in z.infolist() if not i.is_dir()]
        except zipfile.BadZipFile as e:
            raise GameError("File .zip bị hỏng hoặc không phải file zip.") from e
    if source.suffix.lower() in (".rar", ".7z"):
        raise GameError("App mở được gói .zip hoặc thư mục. File .rar/.7z: giải nén ra thư mục trước (chuột phải → Extract) rồi chọn thư mục đó.")
    raise GameError("Chọn file .zip hoặc thư mục gói Việt hóa.")


def _safe(rel: str) -> bool:
    parts = rel.split("/")
    return bool(rel) and not rel.startswith("/") and ".." not in parts and ":" not in parts[0] and not JUNK.search(rel)


def plan(source: Path, game: Path) -> dict:
    """Tìm số cấp thư mục cần bỏ ở đầu đường dẫn trong gói để khớp với thư mục game, rồi liệt kê từng file."""
    if not game.is_dir():
        raise GameError("Không thấy thư mục game.")
    ents = [(r, s) for r, s in _entries(source) if _safe(r)]
    if not ents:
        raise GameError("Gói Việt hóa trống.")
    if sum(s for _, s in ents) > MAX_PATCH:
        raise GameError("Gói quá lớn (trên 20 GB).")
    top = {c.name.lower() for c in game.iterdir()}
    best, best_score = 0, -1
    depth = max(len(r.split("/")) for r, _ in ents)
    for k in range(0, min(depth, 6)):
        score = 0
        for r, _ in ents:
            parts = r.split("/")
            if len(parts) <= k:
                continue
            rest = parts[k:]
            if (game / Path(*rest)).exists():
                score += 3
            elif rest[0].lower() in top:
                score += 1
        if score > best_score:
            best, best_score = k, score
    if best_score <= 0:
        raise GameError("Gói này không khớp với thư mục game đã chọn (không có file/thư mục nào trùng tên). Kiểm tra lại thư mục game.")
    files = []
    for r, size in ents:
        parts = r.split("/")
        if len(parts) <= best:
            continue
        rest = "/".join(parts[best:])
        dst = game / Path(*parts[best:])
        exists = dst.exists()
        first = parts[best].lower()
        inside = first in top or first in KNOWN_ROOT
        files.append({"src": r, "dst": rest, "size": size, "exists": exists, "on": inside,
                      "why": "" if inside else "Thư mục/file mới ở ngoài cùng game – thường là công cụ hay ghi chú của nhóm dịch"})
    files.sort(key=lambda f: (not f["on"], f["dst"].lower()))
    return {"strip": best, "files": files, "game": str(game), "source": str(source),
            "write": sum(1 for f in files if f["on"]), "overwrite": sum(1 for f in files if f["on"] and f["exists"])}


class _Reader:
    """Đọc file trong gói (.zip mở một lần, hoặc thư mục)."""

    def __init__(self, source: Path):
        self.source = source
        self.z = zipfile.ZipFile(source) if source.is_file() else None
        self.names = {n.replace("\\", "/"): n for n in self.z.namelist()} if self.z else {}

    def copy(self, rel: str, dst: Path):
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(dst.name + ".cvtmp")
        if self.z is None:
            shutil.copyfile(self.source / Path(*rel.split("/")), tmp)
        else:
            with self.z.open(self.names[rel]) as f, open(tmp, "wb") as o:
                shutil.copyfileobj(f, o, 1024 * 1024)
        os.replace(tmp, dst)

    def close(self):
        if self.z:
            self.z.close()


def _stamp(p: Path) -> dict:
    st = p.stat()
    return {"size": st.st_size, "mtime": int(st.st_mtime)}


def _manifest_path(mid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", mid or ""):
        raise HTTPException(404, "Không có gói này.")
    return PATCHES / f"{mid}.json"


def _load_m(mid: str) -> dict:
    p = _manifest_path(mid)
    if not p.exists():
        raise HTTPException(404, "Không có gói này.")
    return json.loads(p.read_text(encoding="utf-8"))


def _save_m(m: dict):
    PATCHES.mkdir(parents=True, exist_ok=True)
    tmp = PATCHES / f"{m['id']}.tmp"
    tmp.write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, PATCHES / f"{m['id']}.json")


def install(source: Path, game: Path, chosen: list[str] | None, mid: str | None = None) -> dict:
    pl = plan(source, game)
    pick = set(chosen) if chosen is not None else {f["dst"] for f in pl["files"] if f["on"]}
    todo = [f for f in pl["files"] if f["dst"] in pick]
    if not todo:
        raise GameError("Chưa chọn file nào để cài.")
    old = _load_m(mid) if mid else None
    mid = mid or uuid.uuid4().hex[:12]
    bdir = game / PATCH_BACKUP / mid
    prev = {f["dst"]: f for f in (old or {}).get("files", [])}
    rec = []
    rd = _Reader(source)
    try:
        for f in todo:
            dst = game / Path(*f["dst"].split("/"))
            bak = bdir / Path(*f["dst"].split("/"))
            before = prev.get(f["dst"])
            existed = before["existed"] if before else dst.exists()
            if dst.exists():
                ours = before and _stamp(dst) == {"size": before["size"], "mtime": before["mtime"]}
                if not ours:          # lần đầu, hoặc Steam vừa cập nhật file này: file hiện tại là bản gốc (mới) → sao lưu
                    bak.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(dst, bak)
                    existed = True
            rd.copy(f["src"], dst)
            rec.append({"dst": f["dst"], "existed": existed, **_stamp(dst)})
    finally:
        rd.close()
    m = {"id": mid, "name": source.stem if source.is_file() else source.name, "source": str(source), "game": str(game),
         "game_name": game.name, "installed": time.time(), "files": rec}
    _save_m(m)
    return status(m)


def status(m: dict) -> dict:
    game = Path(m["game"])
    changed = missing = 0
    for f in m["files"]:
        p = game / Path(*f["dst"].split("/"))
        if not p.exists():
            missing += 1
        elif _stamp(p) != {"size": f["size"], "mtime": f["mtime"]}:
            changed += 1
    state = "ok" if not changed and not missing else "overwritten"
    if not game.exists():
        state = "nogame"
    return {"id": m["id"], "name": m["name"], "game": m["game"], "game_name": m.get("game_name") or game.name, "installed": m["installed"],
            "files": len(m["files"]), "changed": changed, "missing": missing, "state": state, "source_ok": Path(m["source"]).exists(),
            "source": m["source"]}


def uninstall(mid: str) -> int:
    m = _load_m(mid)
    game = Path(m["game"])
    bdir = game / PATCH_BACKUP / mid
    n = 0
    for f in m["files"]:
        dst = game / Path(*f["dst"].split("/"))
        bak = bdir / Path(*f["dst"].split("/"))
        if f["existed"] and bak.exists():
            shutil.copy2(bak, dst)
            n += 1
        elif not f["existed"] and dst.exists() and _stamp(dst) == {"size": f["size"], "mtime": f["mtime"]}:
            dst.unlink()                          # file do gói thêm vào (chưa bị thay) → bỏ đi
            n += 1
    shutil.rmtree(bdir, ignore_errors=True)
    with_parent = game / PATCH_BACKUP
    if with_parent.exists() and not any(with_parent.iterdir()):
        with_parent.rmdir()
    _manifest_path(mid).unlink(missing_ok=True)
    return n


# ================================================================== API
router = APIRouter(prefix="/api/translate/vh", dependencies=[Depends(translate._local_only)])


def _err(e: Exception):
    if isinstance(e, PermissionError):
        raise HTTPException(400, "Không ghi được vào thư mục game. Tắt game (và Steam đang cập nhật game) rồi thử lại.")
    raise HTTPException(400, str(e))


@router.get("/steam")
def api_steam():
    return {"games": steam_games()}


class PatchIn(BaseModel):
    source: str
    game: str
    files: list[str] | None = None


def _paths(body: PatchIn) -> tuple[Path, Path]:
    src = Path(body.source.strip().strip('"'))
    game = Path(body.game.strip().strip('"'))
    if not src.exists():
        raise HTTPException(400, "Không thấy file/thư mục gói Việt hóa.")
    root = unity_root(game) or game
    return src, root


@router.post("/preview")
def api_preview(body: PatchIn):
    src, game = _paths(body)
    try:
        pl = plan(src, game)
    except (GameError, OSError) as e:
        _err(e)
    pl["files"] = pl["files"][:3000]
    return pl


@router.post("/install")
def api_install(body: PatchIn):
    src, game = _paths(body)
    same = [m for m in _all() if Path(m["game"]) == game and Path(m["source"]) == src]
    try:
        return install(src, game, body.files, same[0]["id"] if same else None)
    except (GameError, OSError, KeyError, zipfile.BadZipFile) as e:
        _err(e)


def _all() -> list[dict]:
    out = []
    if PATCHES.exists():
        for f in PATCHES.glob("*.json"):
            try:
                out.append(json.loads(f.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
    return out


@router.get("")
def api_list():
    return {"patches": sorted((status(m) for m in _all()), key=lambda x: -x["installed"])}


@router.post("/{mid}/reinstall")
def api_reinstall(mid: str):
    m = _load_m(mid)
    src, game = Path(m["source"]), Path(m["game"])
    if not src.exists():
        raise HTTPException(400, "Không còn file gói Việt hóa ở chỗ cũ. Chọn lại file rồi bấm Cài.")
    try:
        return install(src, game, [f["dst"] for f in m["files"]], mid)
    except (GameError, OSError, KeyError, zipfile.BadZipFile) as e:
        _err(e)


@router.post("/{mid}/uninstall")
def api_uninstall(mid: str):
    try:
        return {"ok": True, "files": uninstall(mid)}
    except OSError as e:
        _err(e)

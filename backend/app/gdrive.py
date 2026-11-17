"""Google Drive của người dùng: lưu nhạc lên Drive (nhiều tài khoản, chọn tài khoản + thư mục, đổi lúc nào cũng được).

- OAuth "Desktop app" do người dùng tự tạo trong Google Cloud (Client ID/secret lưu ở DATA/gdrive.json, chỉ trên máy này).
  Đăng nhập = trình duyệt mở trang Google → quay về http://127.0.0.1:<cổng>/api/gdrive/auth/callback (PKCE + state).
- Chỉ xin quyền `drive.file`: app chỉ thấy/sửa file do CircleVault tạo (app điện thoại cùng project Google cũng thấy).
- Mỗi tài khoản có một thư mục gốc (mặc định "CircleVault"); playlist = thư mục con cùng tên; bài không thuộc playlist nằm ở gốc.
- Tải lên chạy nền, tải tiếp kiểu "resumable"; nhớ file đã tải (theo đường dẫn trên máy) để không tải trùng.
Router chỉ cho máy này (127.0.0.1) – có token Google.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import secrets
import threading
import time
import uuid
from urllib.parse import urlencode

import requests
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from . import config, db, devices

router = APIRouter(prefix="/api/gdrive", dependencies=[Depends(devices.local_only)])
PATH = config.DATA / "gdrive.json"
SCOPE = "openid email profile https://www.googleapis.com/auth/drive.file"
AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
REVOKE = "https://oauth2.googleapis.com/revoke"
API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
FOLDER = "application/vnd.google-apps.folder"

_lock = threading.RLock()
_pending: dict[str, dict] = {}            # state → {verifier, redirect, at}
_tokens: dict[str, tuple[str, float]] = {}  # email → (access token, hết hạn)
_jobs: dict[str, dict] = {}


# ------------------------------------------------------------------ lưu cấu hình
def _load() -> dict:
    try:
        d = json.loads(PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        d = {}
    d.setdefault("client", {})
    d.setdefault("accounts", [])
    d.setdefault("uploaded", {})
    return d


def _save(d: dict) -> None:
    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(PATH)


def _account(d: dict, email: str | None) -> dict:
    email = email or d.get("active")
    acc = next((a for a in d["accounts"] if a["email"] == email), None)
    if not acc:
        raise HTTPException(400, "Chưa chọn tài khoản Google Drive.")
    return acc


def _public(d: dict) -> dict:
    cid = d["client"].get("id", "")
    return {
        "configured": bool(cid and d["client"].get("secret")),
        "client_id": (cid[:14] + "…" + cid[-28:]) if len(cid) > 50 else cid,
        "active": d.get("active"),
        "accounts": [{"email": a["email"], "name": a.get("name"), "folder_name": a.get("folder_name"),
                      "folder_id": a.get("folder_id"), "uploaded": len(d["uploaded"].get(a["email"], {}))}
                     for a in d["accounts"]],
        "jobs": [{k: v for k, v in j.items() if not k.startswith("_")} for j in _jobs.values()],
    }


# ------------------------------------------------------------------ gọi Google
def _post_token(data: dict) -> dict:
    r = requests.post(TOKEN, data=data, timeout=30)
    j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200:
        msg = j.get("error_description") or j.get("error") or f"Lỗi {r.status_code}"
        if j.get("error") == "invalid_grant":
            msg = "Phiên đăng nhập Google đã hết hạn hoặc bị thu hồi. Hãy thêm lại tài khoản."
        raise HTTPException(400, msg)
    return j


def access_token(email: str) -> str:
    with _lock:
        t = _tokens.get(email)
        if t and t[1] > time.time() + 60:
            return t[0]
        d = _load()
        acc = _account(d, email)
        j = _post_token({"client_id": d["client"]["id"], "client_secret": d["client"]["secret"],
                         "refresh_token": acc["refresh"], "grant_type": "refresh_token"})
        _tokens[email] = (j["access_token"], time.time() + int(j.get("expires_in", 3600)))
        return j["access_token"]


def _drive(method: str, url: str, email: str, **kw) -> requests.Response:
    h = kw.pop("headers", {})
    h["Authorization"] = f"Bearer {access_token(email)}"
    r = requests.request(method, url, headers=h, timeout=kw.pop("timeout", 60), **kw)
    if r.status_code == 401:                         # token vừa hết hạn → lấy lại một lần
        _tokens.pop(email, None)
        h["Authorization"] = f"Bearer {access_token(email)}"
        r = requests.request(method, url, headers=h, timeout=60, **kw)
    return r


def _check(r: requests.Response, what: str) -> dict:
    if r.status_code >= 400:
        try:
            msg = r.json()["error"]["message"]
        except Exception:  # noqa: BLE001
            msg = r.text[:200]
        if "has not been used" in msg or "is disabled" in msg:
            msg = "Google Drive API chưa bật trong project Google Cloud (APIs & Services → Library → Google Drive API → Enable)."
        raise HTTPException(502, f"{what}: {msg}")
    return r.json() if r.content else {}


def _q(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


def folders(email: str) -> list[dict]:
    """Các thư mục CircleVault đã tạo trong Drive (quyền drive.file chỉ thấy những thư mục này)."""
    r = _drive("GET", f"{API}/files", email, params={
        "q": f"mimeType='{FOLDER}' and trashed=false", "fields": "files(id,name,parents)", "pageSize": 200,
        "orderBy": "name"})
    return _check(r, "Không đọc được thư mục")["files"]


def ensure_folder(email: str, name: str, parent: str | None = None) -> str:
    q = f"mimeType='{FOLDER}' and trashed=false and name='{_q(name)}'" + (f" and '{parent}' in parents" if parent else "")
    found = _check(_drive("GET", f"{API}/files", email, params={"q": q, "fields": "files(id)", "pageSize": 1}), "Không tìm được thư mục")
    if found.get("files"):
        return found["files"][0]["id"]
    meta = {"name": name, "mimeType": FOLDER, **({"parents": [parent]} if parent else {})}
    return _check(_drive("POST", f"{API}/files", email, json=meta, params={"fields": "id"}), "Không tạo được thư mục")["id"]


# ------------------------------------------------------------------ API: cài đặt + tài khoản
class ClientIn(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    json_text: str = ""            # nội dung file client_secret_….json tải từ Google


@router.get("")
def status():
    return _public(_load())


@router.put("/client")
def set_client(body: ClientIn):
    cid, sec = body.client_id.strip(), body.client_secret.strip()
    if body.json_text.strip():
        try:
            j = json.loads(body.json_text)
            j = j.get("installed") or j.get("web") or j
            cid, sec = j["client_id"], j.get("client_secret", "")
        except (ValueError, KeyError, TypeError):
            raise HTTPException(400, "File này không phải file JSON của OAuth client (tải ở Google Cloud → Clients → Download JSON).")
    if not cid.endswith(".apps.googleusercontent.com") or not sec:
        raise HTTPException(400, "Cần Client ID (đuôi .apps.googleusercontent.com) và Client secret của client loại Desktop app.")
    d = _load()
    d["client"] = {"id": cid, "secret": sec}
    _save(d)
    return _public(d)


@router.post("/auth/start")
def auth_start(request: Request):
    d = _load()
    if not d["client"].get("id"):
        raise HTTPException(400, "Chưa nhập Client ID / Client secret.")
    port = request.url.port or int(os.environ.get("CIRCLEVAULT_PORT") or 8686)
    redirect = f"http://127.0.0.1:{port}/api/gdrive/auth/callback"
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    now = time.time()
    for k in [k for k, v in _pending.items() if v["at"] < now - 900]:
        _pending.pop(k, None)
    _pending[state] = {"verifier": verifier, "redirect": redirect, "at": now}
    q = {"client_id": d["client"]["id"], "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
         "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
         "access_type": "offline", "prompt": "consent select_account", "include_granted_scopes": "true"}
    return {"url": f"{AUTH}?{urlencode(q)}"}


def _page(title: str, msg: str, ok: bool) -> HTMLResponse:
    color = "#3be08c" if ok else "#ff5a5f"
    return HTMLResponse(f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><body style="margin:0;font:16px/1.6 system-ui,sans-serif;background:#fbf9f4;color:#121212;display:grid;place-items:center;min-height:100vh">
<div style="max-width:460px;margin:16px;padding:22px;border:3px solid #121212;box-shadow:5px 5px 0 #121212;border-radius:8px;background:#fff">
<div style="height:10px;background:{color};border:2px solid #121212;border-radius:4px;margin-bottom:14px"></div>
<h2 style="margin:0 0 8px">{title}</h2><p style="margin:0">{msg}</p></div></body>""", status_code=200 if ok else 400)


@router.get("/auth/callback")
def auth_callback(state: str = "", code: str = "", error: str = ""):
    p = _pending.pop(state, None)
    if error:
        return _page("Chưa kết nối", "Bạn đã hủy hoặc Google từ chối. Đóng tab này và thử lại trong CircleVault.", False)
    if not p or not code:
        return _page("Liên kết đã hết hạn", "Hãy bấm “Thêm tài khoản Google” lại trong CircleVault.", False)
    d = _load()
    try:
        j = _post_token({"client_id": d["client"]["id"], "client_secret": d["client"]["secret"], "code": code,
                         "code_verifier": p["verifier"], "redirect_uri": p["redirect"], "grant_type": "authorization_code"})
    except HTTPException as e:
        return _page("Không kết nối được", str(e.detail), False)
    claims = {}
    try:
        part = j.get("id_token", "").split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        pass
    email = claims.get("email") or "tai-khoan"
    if "drive.file" not in j.get("scope", ""):
        return _page("Thiếu quyền Google Drive", "Ở màn hình của Google, hãy tick ô cho phép CircleVault truy cập Google Drive rồi thử lại.", False)
    with _lock:
        d = _load()
        acc = next((a for a in d["accounts"] if a["email"] == email), None)
        if not acc:
            acc = {"email": email}
            d["accounts"].append(acc)
        acc["name"] = claims.get("name") or email
        if j.get("refresh_token"):
            acc["refresh"] = j["refresh_token"]
        _tokens[email] = (j["access_token"], time.time() + int(j.get("expires_in", 3600)))
        if not d.get("active"):
            d["active"] = email
        _save(d)
    if not acc.get("folder_id"):
        try:
            fid = ensure_folder(email, "CircleVault")
            with _lock:
                d = _load()
                a = _account(d, email)
                a["folder_id"], a["folder_name"] = fid, "CircleVault"
                _save(d)
        except HTTPException as e:
            return _page("Đã đăng nhập, nhưng chưa tạo được thư mục", str(e.detail), False)
    return _page("Đã kết nối Google Drive", f"Tài khoản <b>{email}</b> đã sẵn sàng. Đóng tab này và quay lại CircleVault.", True)


class EmailIn(BaseModel):
    email: str


class FolderIn(BaseModel):
    email: str
    name: str = ""
    id: str = ""


@router.post("/active")
def set_active(body: EmailIn):
    d = _load()
    _account(d, body.email)
    d["active"] = body.email
    _save(d)
    return _public(d)


@router.get("/folders")
def list_folders(email: str):
    out = [f for f in folders(email)]
    return out


@router.post("/folder")
def set_folder(body: FolderIn):
    """Chọn thư mục lưu: một thư mục CircleVault đã tạo (id) hoặc tạo mới theo tên."""
    name = body.name.strip()[:100]
    if body.id:
        f = next((x for x in folders(body.email) if x["id"] == body.id), None)
        if not f:
            raise HTTPException(404, "Không thấy thư mục này.")
        fid, name = f["id"], f["name"]
    elif name:
        fid = ensure_folder(body.email, name)
    else:
        raise HTTPException(400, "Cần tên thư mục.")
    with _lock:
        d = _load()
        a = _account(d, body.email)
        a["folder_id"], a["folder_name"] = fid, name
        _save(d)
    return _public(d)


@router.delete("/accounts/{email}")
def remove_account(email: str):
    with _lock:
        d = _load()
        acc = _account(d, email)
        if acc.get("refresh"):
            try:
                requests.post(REVOKE, params={"token": acc["refresh"]}, timeout=15)
            except requests.RequestException:
                pass
        d["accounts"] = [a for a in d["accounts"] if a["email"] != email]
        d["uploaded"].pop(email, None)
        if d.get("active") == email:
            d["active"] = d["accounts"][0]["email"] if d["accounts"] else None
        _tokens.pop(email, None)
        _save(d)
    return _public(d)


# ------------------------------------------------------------------ tải nhạc lên
class UploadIn(BaseModel):
    track_ids: list[int] = []
    playlist_id: int | None = None
    all: bool = False
    email: str | None = None


def _upload_file(email: str, path: str, parent: str, name: str, job: dict) -> str:
    size = os.path.getsize(path)
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    meta = {"name": name, "parents": [parent], "appProperties": {"cvsrc": hashlib.sha1(path.encode()).hexdigest()}}
    r = _drive("POST", UPLOAD, email, params={"uploadType": "resumable", "fields": "id"}, json=meta,
               headers={"X-Upload-Content-Type": mime, "X-Upload-Content-Length": str(size)})
    _check(r, "Không bắt đầu tải lên được")
    loc = r.headers["Location"]
    sent, chunk = 0, 8 * 1024 * 1024
    with open(path, "rb") as f:
        while True:
            if job.get("canceled"):
                raise RuntimeError("Đã hủy.")
            data = f.read(chunk)
            end = sent + len(data) - 1
            h = {"Content-Range": f"bytes {sent}-{end}/{size}" if data else f"bytes */{size}"}
            r = requests.put(loc, data=data, headers=h, timeout=300)
            if r.status_code in (200, 201):
                job["bytes_done"] += len(data)
                return r.json()["id"]
            if r.status_code != 308:
                _check(r, "Tải lên bị lỗi")
            sent = end + 1
            job["bytes_done"] += len(data)
            if not data:
                raise RuntimeError("Google không nhận đủ file.")


def _run(job: dict, email: str, groups: list[tuple[str | None, list[dict]]]) -> None:
    job["status"] = "running"
    try:
        d = _load()
        acc = _account(d, email)
        root = acc.get("folder_id") or ensure_folder(email, acc.get("folder_name") or "CircleVault")
        for folder_name, tracks in groups:
            parent = ensure_folder(email, folder_name, root) if folder_name else root
            for t in tracks:
                if job.get("canceled"):
                    raise RuntimeError("Đã hủy.")
                job["current"] = t["title"] or os.path.basename(t["path"])
                key = f"{folder_name or ''}|{t['path']}"
                done = _load()["uploaded"].get(email, {})
                if key in done or not os.path.exists(t["path"]):
                    job["skipped"] += 1
                    job["bytes_done"] += t.get("size") or 0
                else:
                    try:
                        fid = _upload_file(email, t["path"], parent, os.path.basename(t["path"]), job)
                        with _lock:
                            d = _load()
                            d["uploaded"].setdefault(email, {})[key] = fid
                            _save(d)
                        job["uploaded"] += 1
                    except HTTPException as e:
                        job["errors"].append(f"{job['current']}: {e.detail}")
                    except (requests.RequestException, OSError) as e:
                        job["errors"].append(f"{job['current']}: {e}")
                job["done"] += 1
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001
        job.update(status="error", error=getattr(e, "detail", None) or str(e))
    finally:
        job["current"] = None
        job["finished_at"] = time.time()


@router.post("/upload")
def upload(body: UploadIn):
    d = _load()
    acc = _account(d, body.email)
    email = acc["email"]
    groups: list[tuple[str | None, list[dict]]] = []
    if body.playlist_id:
        pl = db.one("SELECT * FROM playlists WHERE id=?", (body.playlist_id,))
        if not pl:
            raise HTTPException(404, "Không thấy playlist.")
        ids = json.loads(pl["track_ids"] or "[]")
        rows = {r["id"]: r for r in db.query(f"SELECT * FROM tracks WHERE id IN ({','.join('?' * len(ids))})", tuple(ids))} if ids else {}
        groups.append((pl["name"], [rows[i] for i in ids if i in rows]))
    elif body.all:
        groups.append((None, db.query("SELECT * FROM tracks ORDER BY added_at DESC")))
    else:
        ids = body.track_ids[:2000]
        groups.append((None, db.query(f"SELECT * FROM tracks WHERE id IN ({','.join('?' * len(ids))})", tuple(ids)) if ids else []))
    total = sum(len(g[1]) for g in groups)
    if not total:
        raise HTTPException(400, "Không có bài nào để tải lên.")
    for k in [k for k, j in _jobs.items() if j.get("finished_at") and j["finished_at"] < time.time() - 3600]:
        _jobs.pop(k, None)
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "email": email, "folder": acc.get("folder_name"), "label": groups[0][0] or "Bài hát",
           "total": total, "done": 0, "uploaded": 0, "skipped": 0, "errors": [], "current": None, "status": "queued",
           "bytes_total": sum((t.get("size") or 0) for g in groups for t in g[1]), "bytes_done": 0, "error": None}
    _jobs[jid] = job
    from . import applog
    threading.Thread(target=applog.wrap("Google Drive: tải lên", _run, job, email, groups, job=job, limit=600), daemon=True).start()
    return {k: v for k, v in job.items()}


@router.post("/jobs/{jid}/cancel")
def cancel(jid: str):
    if jid in _jobs:
        _jobs[jid]["canceled"] = True
    return {"ok": True}

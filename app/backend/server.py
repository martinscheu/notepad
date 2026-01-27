from __future__ import annotations

import io
import json
import time
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, jsonify, request, send_file, send_from_directory
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.units import mm
try:
    import yaml
except Exception:
    yaml = None

FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"




def _pdf_wrap_lines(text: str, c, max_width: float, font_name: str, font_size: int):
    # Basic word-wrap; preserves existing newlines
    lines_out = []
    for raw_line in (text or "").splitlines():
        if not raw_line:
            lines_out.append("")
            continue
        words = raw_line.split(" ")
        cur = ""
        for w in words:
            cand = (cur + " " + w).strip() if cur else w
            if pdfmetrics.stringWidth(cand, font_name, font_size) <= max_width:
                cur = cand
            else:
                if cur:
                    lines_out.append(cur)
                # if single word longer than width, hard-split
                if pdfmetrics.stringWidth(w, font_name, font_size) <= max_width:
                    cur = w
                else:
                    chunk = ""
                    for ch in w:
                        cand2 = chunk + ch
                        if pdfmetrics.stringWidth(cand2, font_name, font_size) <= max_width:
                            chunk = cand2
                        else:
                            if chunk:
                                lines_out.append(chunk)
                            chunk = ch
                    cur = chunk
        if cur:
            lines_out.append(cur)
    return lines_out
app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="/static")


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(FRONTEND_DIR, "favicon.ico", mimetype="image/x-icon")

# ---------- Config ----------
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))

NOTES_DIR = DATA_DIR / "notes"
TRASH_DIR = DATA_DIR / "trash"
EXPORTS_DIR = DATA_DIR / "exports"
INDEX_PATH = DATA_DIR / "index.json"

SAFE_TITLE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_dirs() -> None:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        tmp = NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False)
        tmp.write(text)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, path)
    finally:
        if tmp is not None and os.path.exists(tmp.name):
            try:
                os.unlink(tmp.name)
            except Exception:
                pass


def gen_id() -> str:
    import secrets
    return secrets.token_hex(4)  # 8 hex chars


def slugify_title(title: str) -> str:
    title = title.strip()
    if not title:
        return ""
    title = SAFE_TITLE_RE.sub("-", title).strip("-")
    return title[:60]


def mk_basename(note_id: str, user_title: str = "", created_dt: Optional[datetime] = None) -> str:
    dt = created_dt or datetime.now(timezone.utc)
    stamp = dt.strftime("%Y-%m-%d_%H-%M-%S")
    slug = slugify_title(user_title)
    if slug:
        return f"{stamp}_{note_id}_{slug}"
    return f"{stamp}_{note_id}"


def load_json(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))


def save_json(p: Path, obj: Dict[str, Any]) -> None:
    atomic_write_text(p, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def load_index() -> Optional[List[Dict[str, Any]]]:
    if not INDEX_PATH.exists():
        return None
    try:
        data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("notes"), list):
            return data["notes"]
        if isinstance(data, list):
            return data
    except Exception:
        return None
    return None


def save_index(metas: List[Dict[str, Any]]) -> None:
    payload = {"version": 1, "notes": metas}
    atomic_write_text(INDEX_PATH, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def rebuild_index() -> List[Dict[str, Any]]:
    metas = []
    for base_dir, deleted in [(NOTES_DIR, False), (TRASH_DIR, True)]:
        for meta in base_dir.glob("*.json"):
            try:
                m = load_json(meta)
            except Exception:
                continue
            m["deleted"] = bool(m.get("deleted", deleted))
            metas.append(m)
    save_index(metas)
    return metas


def update_index_meta(meta: Dict[str, Any]) -> None:
    metas = load_index()
    if metas is None:
        rebuild_index()
        return
    note_id = meta.get("id")
    if not note_id:
        return
    updated = False
    for i, m in enumerate(metas):
        if m.get("id") == note_id:
            metas[i] = meta
            updated = True
            break
    if not updated:
        metas.append(meta)
    save_index(metas)


def find_note_files_by_id(note_id: str) -> Tuple[Optional[Path], Optional[Path], bool]:
    for base_dir, deleted in [(NOTES_DIR, False), (TRASH_DIR, True)]:
        for meta in base_dir.glob("*.json"):
            try:
                m = load_json(meta)
            except Exception:
                continue
            if m.get("id") == note_id:
                # content may be md or txt; md preferred
                md = meta.with_suffix(".md")
                txt = meta.with_suffix(".txt")
                content = md if md.exists() else (txt if txt.exists() else None)
                return (content, meta, deleted)
    return (None, None, False)


def list_metas(include_deleted: bool = False) -> List[Dict[str, Any]]:
    metas = load_index()
    if metas is None:
        metas = rebuild_index()
    if include_deleted:
        return metas
    return [m for m in metas if not m.get("deleted")]


def sort_metas(metas: List[Dict[str, Any]], sort_key: str) -> List[Dict[str, Any]]:
    def pinned_rank(m: Dict[str, Any]) -> int:
        return 0 if m.get("pinned") else 1

    if sort_key == "created":
        by_created = sorted(metas, key=lambda m: m.get("created", ""), reverse=True)
        return sorted(by_created, key=pinned_rank)
    if sort_key == "filename":
        by_filename = sorted(metas, key=lambda m: m.get("filename", ""))
        return sorted(by_filename, key=pinned_rank)
    by_updated = sorted(metas, key=lambda m: m.get("updated", ""), reverse=True)
    return sorted(by_updated, key=pinned_rank)


# ---------- Frontend ----------
from flask import send_file

@app.route("/")
def index():
    return send_file(FRONTEND_DIR / "index.html")

# ---------- Health ----------
@app.route("/health")
def health():
    ensure_dirs()
    return {"status": "ok"}


# ---------- API ----------
@app.route("/api/notes", methods=["GET"])
def api_list_notes():
    ensure_dirs()
    if load_index() is None:
        rebuild_index()
    include_deleted = request.args.get("include_deleted", "false").lower() == "true"
    sort_key = request.args.get("sort", "updated")
    q = request.args.get("q", "").strip().lower()

    metas = list_metas(include_deleted=include_deleted)

    if q:
        filtered: List[Dict[str, Any]] = []
        for m in metas:
            fn = (m.get("filename") or "").lower()
            title = (m.get("user_title") or m.get("title") or "").lower()
            if q in fn or (title and q in title):
                filtered.append(m)
                continue
            note_id = m.get("id")
            if not note_id:
                continue
            content_path, _, _ = find_note_files_by_id(note_id)
            if content_path and content_path.exists():
                try:
                    txt = content_path.read_text(encoding="utf-8", errors="ignore").lower()
                    if q in txt:
                        filtered.append(m)
                except Exception:
                    pass
        metas = filtered

    metas = sort_metas(metas, sort_key)
    return jsonify(metas)


@app.route("/api/index/rebuild", methods=["POST"])
def api_rebuild_index():
    ensure_dirs()
    metas = rebuild_index()
    return jsonify({"ok": True, "count": len(metas)})


@app.route("/api/notes", methods=["POST"])
def api_create_note():
    ensure_dirs()
    body = request.get_json(silent=True) or {}
    ext = body.get("ext", "md")
    if ext not in ("md", "txt"):
        ext = "md"

    created_dt = datetime.now(timezone.utc).replace(microsecond=0)

    for _ in range(20):
        note_id = gen_id()
        basename = mk_basename(note_id, user_title="", created_dt=created_dt)
        content_path = NOTES_DIR / f"{basename}.{ext}"
        meta_path = NOTES_DIR / f"{basename}.json"
        if not content_path.exists() and not meta_path.exists():
            break
    else:
        return jsonify({"error": "Failed to allocate note id"}), 500

    atomic_write_text(content_path, "")
    created_iso = created_dt.isoformat().replace("+00:00", "Z")
    meta = {
        "id": note_id,
        "created": created_iso,
        "updated": created_iso,
        "rev": 1,
        "filename": content_path.name,
        "title": "",
        "pinned": False,
        "deleted": False,
    }
    save_json(meta_path, meta)
    update_index_meta(meta)
    return jsonify(meta), 201


@app.route("/api/preview/yaml", methods=["POST"])
def api_preview_yaml():
    if yaml is None:
        return jsonify({"ok": False, "error": "PyYAML not installed"}), 500
    body = request.get_json(silent=True) or {}
    text = body.get("text", "")
    if not str(text).strip():
        return jsonify({"ok": False, "error": "Empty YAML"}), 200
    try:
        data = yaml.safe_load(text)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200
    try:
        pretty = yaml.safe_dump(data, sort_keys=False, allow_unicode=False)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200
    return jsonify({"ok": True, "pretty": pretty})


@app.route("/api/notes/import", methods=["POST"])
def api_import_notes():
    ensure_dirs()
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "No files provided"}), 400

    created: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []

    for f in files:
        filename = (f.filename or "").strip()
        if not filename:
            errors.append({"file": "", "error": "Missing filename"})
            continue

        safe_name = Path(filename).name
        ext = Path(safe_name).suffix.lower().lstrip(".")
        if ext not in ("md", "txt"):
            errors.append({"file": safe_name, "error": "Unsupported file type"})
            continue

        try:
            raw = f.read()
            text = raw.decode("utf-8", errors="replace")
        except Exception:
            errors.append({"file": safe_name, "error": "Failed to read file"})
            continue

        created_dt = datetime.now(timezone.utc).replace(microsecond=0)
        title = Path(safe_name).stem

        for _ in range(20):
            note_id = gen_id()
            basename = mk_basename(note_id, user_title=title, created_dt=created_dt)
            content_path = NOTES_DIR / f"{basename}.{ext}"
            meta_path = NOTES_DIR / f"{basename}.json"
            if not content_path.exists() and not meta_path.exists():
                break
        else:
            errors.append({"file": safe_name, "error": "Failed to allocate note id"})
            continue

        atomic_write_text(content_path, text)
        created_iso = created_dt.isoformat().replace("+00:00", "Z")
        meta = {
            "id": note_id,
            "created": created_iso,
            "updated": created_iso,
            "rev": 1,
            "filename": content_path.name,
            "title": title,
            "pinned": False,
            "deleted": False,
        }
        save_json(meta_path, meta)
        update_index_meta(meta)
        created.append(meta)

    if not created:
        return jsonify({"error": "No valid files imported", "errors": errors}), 400
    return jsonify({"created": created, "errors": errors})


@app.route("/api/notes/<note_id>", methods=["GET"])
def api_get_note(note_id: str):
    ensure_dirs()
    content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404

    meta = load_json(meta_path)
    meta["deleted"] = bool(meta.get("deleted", deleted))
    content = ""
    if content_path and content_path.exists():
        content = content_path.read_text(encoding="utf-8", errors="ignore")
    return jsonify({"meta": meta, "content": content})


@app.route("/api/notes/<note_id>/content", methods=["PUT"])
def api_save_content(note_id: str):
    ensure_dirs()
    body = request.get_json(force=True)
    content = body.get("content", "")
    base_rev = int(body.get("base_rev", 0))

    content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404
    if deleted:
        return jsonify({"error": "Note is deleted"}), 400

    meta = load_json(meta_path)
    meta["rev"] = int(meta.get("rev", 0)) + 1
    meta["updated"] = utc_now_iso()

    if content_path is None:
        fn = meta.get("filename")
        if not fn:
            return jsonify({"error": "Corrupt note (missing filename)"}), 500
        content_path = NOTES_DIR / fn

    atomic_write_text(content_path, content)
    save_json(meta_path, meta)
    update_index_meta(meta)
    return jsonify({"rev": meta["rev"], "updated": meta["updated"], "base_rev": base_rev})


@app.route("/api/notes/<note_id>/meta", methods=["PUT"])
def api_update_meta(note_id: str):
    ensure_dirs()
    body = request.get_json(force=True)
    new_title = body.get("user_title", None)
    pinned = body.get("pinned", None)
    display_title = body.get("title", None)

    content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404
    if deleted:
        return jsonify({"error": "Note is deleted"}), 400

    meta = load_json(meta_path)

    if pinned is not None:
        meta["pinned"] = bool(pinned)
        meta["updated"] = utc_now_iso()
        meta["rev"] = int(meta.get("rev", 0)) + 1

    if new_title is not None:
        meta["title"] = str(new_title).strip()
        fn = meta.get("filename", "")
        ext = Path(fn).suffix.lstrip(".") if fn else "md"

        created_stamp = fn.split(f"_{note_id}", 1)[0] if fn and f"_{note_id}" in fn else datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
        slug = slugify_title(str(new_title))
        if slug:
            new_basename = f"{created_stamp}_{note_id}_{slug}"
        else:
            new_basename = f"{created_stamp}_{note_id}"

        new_content = NOTES_DIR / f"{new_basename}.{ext}"
        new_meta = NOTES_DIR / f"{new_basename}.json"

        if (new_content.exists() and (content_path is None or new_content.resolve() != content_path.resolve())) or \
           (new_meta.exists() and new_meta.resolve() != meta_path.resolve()):
            return jsonify({"error": "Target filename already exists"}), 409

        if content_path and content_path.exists():
            content_path.rename(new_content)
        meta_path.rename(new_meta)

        meta_path = new_meta
        content_path = new_content
        meta["filename"] = new_content.name
        meta["updated"] = utc_now_iso()
        meta["rev"] = int(meta.get("rev", 0)) + 1
    elif display_title is not None:
        meta["title"] = str(display_title).strip()
        meta["updated"] = utc_now_iso()
        meta["rev"] = int(meta.get("rev", 0)) + 1

    save_json(meta_path, meta)
    update_index_meta(meta)
    return jsonify(meta)


@app.route("/api/notes/<note_id>", methods=["DELETE"])
def api_delete_note(note_id: str):
    ensure_dirs()
    content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404
    if deleted:
        return jsonify({"ok": True, "already_deleted": True})

    meta = load_json(meta_path)
    meta["deleted"] = True
    meta["updated"] = utc_now_iso()
    meta["rev"] = int(meta.get("rev", 0)) + 1

    target_meta = TRASH_DIR / meta_path.name
    target_content = TRASH_DIR / (content_path.name if content_path else Path(meta.get("filename", "")).name)

    if content_path and content_path.exists():
        shutil.move(str(content_path), str(target_content))
    shutil.move(str(meta_path), str(target_meta))
    save_json(target_meta, meta)
    update_index_meta(meta)

    return jsonify({"ok": True})


@app.route("/api/notes/<note_id>/restore", methods=["POST"])
def api_restore_note(note_id: str):
    ensure_dirs()
    content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404
    if not deleted:
        return jsonify({"ok": True, "already_active": True})

    meta = load_json(meta_path)
    meta["deleted"] = False
    meta["updated"] = utc_now_iso()
    meta["rev"] = int(meta.get("rev", 0)) + 1

    target_meta = NOTES_DIR / meta_path.name
    target_content = NOTES_DIR / (content_path.name if content_path else meta.get("filename", ""))

    if content_path and content_path.exists():
        shutil.move(str(content_path), str(target_content))
    shutil.move(str(meta_path), str(target_meta))
    save_json(target_meta, meta)
    update_index_meta(meta)

    return jsonify({"ok": True})



@app.route("/api/notes/<note_id>/download", methods=["GET"])
def api_download_note(note_id: str):
    ensure_dirs()
    content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404
    meta = load_json(meta_path)

    content = ""
    if content_path and content_path.exists():
        content = content_path.read_text(encoding="utf-8", errors="ignore")

    title = (meta.get("title") or "").strip()
    if title:
        safe = SAFE_TITLE_RE.sub("-", title).strip("-")[:80] or "note"
        dl_name = f"{safe}.md"
    else:
        dl_name = meta.get("filename") or f"{note_id}.md"
        if not dl_name.endswith(".md"):
            dl_name = dl_name.rsplit(".", 1)[0] + ".md"

    buf = io.BytesIO(content.encode("utf-8"))
    buf.seek(0)
    return send_file(buf, mimetype="text/markdown; charset=utf-8", as_attachment=True, download_name=dl_name)


@app.route("/api/export/all", methods=["GET"])
def api_export_all():
    ensure_dirs()
    include_deleted = request.args.get("include_deleted", "false").lower() == "true"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for base_dir, folder in [(NOTES_DIR, "notes"), (TRASH_DIR, "trash")]:
            if base_dir == TRASH_DIR and not include_deleted:
                continue
            for p in base_dir.iterdir():
                if p.is_file() and (p.suffix in [".md", ".txt", ".json"]):
                    z.write(p, arcname=f"{folder}/{p.name}")

    buf.seek(0)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"stickynotes_export_{ts}.zip",
    )



@app.route("/api/export_selected", methods=["POST"])
def api_export_selected():
    ensure_dirs()
    payload = request.get_json(silent=True) or {}
    ids = payload.get("ids") or []
    if not isinstance(ids, list):
        return jsonify({"error": "ids must be a list"}), 400

    mem = io.BytesIO()
    with zipfile.ZipFile(mem, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for note_id in ids:
            note_id = str(note_id)
            content_path, meta_path, _deleted = find_note_files_by_id(note_id)
            if meta_path and meta_path.exists():
                zf.write(meta_path, arcname=meta_path.name)
            if content_path and content_path.exists():
                zf.write(content_path, arcname=content_path.name)

    mem.seek(0)
    return send_file(mem, mimetype="application/zip", as_attachment=True, download_name="notes-selected.zip")



# ---- Sync (WebDAV) settings ----
SYNC_DIR = os.path.join(DATA_DIR, "sync")
SYNC_SETTINGS = os.path.join(SYNC_DIR, "settings.json")
SYNC_STATUS = os.path.join(SYNC_DIR, "status.json")
SYNC_RUN_ONCE = os.path.join(SYNC_DIR, "run_once")

def _ensure_sync_dirs():
    os.makedirs(SYNC_DIR, exist_ok=True)
    os.makedirs(os.path.join(SYNC_DIR, "logs"), exist_ok=True)

def _default_sync_settings():
    return {
        "enabled": False,
        "paused": False,
        "webdav_url": "",
        "remote_path": "",
        "username": "",
        "password": "",
        "mode": "push",
        "interval_s": 60,
        "no_deletes": True,
    }

@app.route("/api/sync/settings", methods=["GET"])
def api_get_sync_settings():
    _ensure_sync_dirs()
    if os.path.exists(SYNC_SETTINGS):
        try:
            with open(SYNC_SETTINGS, "r", encoding="utf-8") as f:
                j = json.load(f)
            d = _default_sync_settings()
            d.update(j or {})
            return jsonify(d)
        except Exception:
            return jsonify(_default_sync_settings())
    return jsonify(_default_sync_settings())

@app.route("/api/sync/settings", methods=["POST"])
def api_set_sync_settings():
    _ensure_sync_dirs()
    try:
        payload = request.get_json(force=True) or {}
        d = _default_sync_settings()
        d.update({
            "enabled": bool(payload.get("enabled", False)),
            "webdav_url": str(payload.get("webdav_url","")).strip(),
            "remote_path": str(payload.get("remote_path","")).strip(),
            "username": str(payload.get("username","")).strip(),
            "password": str(payload.get("password","")),
            "mode": str(payload.get("mode","push")).strip() or "push",
            "interval_s": int(payload.get("interval_s", 60) or 60),
            "no_deletes": bool(payload.get("no_deletes", True)),
        })
        if d["interval_s"] < 10:
            d["interval_s"] = 10
        with open(SYNC_SETTINGS, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

@app.route("/api/sync/status", methods=["GET"])
def api_get_sync_status():
    _ensure_sync_dirs()
    if os.path.exists(SYNC_STATUS):
        try:
            with open(SYNC_STATUS, "r", encoding="utf-8") as f:
                return jsonify(json.load(f))
        except Exception:
            pass
    return jsonify({"last_result": "idle", "last_time": "never"})

@app.route("/api/sync/run", methods=["POST"])
def api_sync_run():
    _ensure_sync_dirs()
    try:
        now = int(time.time())
        with open(SYNC_RUN_ONCE, "w", encoding="utf-8") as f:
            f.write(str(now))

        # Immediately write a status marker so the UI reflects the request
        status = {
            "last_result": "requested",
            "last_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        }
        try:
            with open(SYNC_STATUS, "w", encoding="utf-8") as f:
                json.dump(status, f)
        except Exception:
            pass

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/api/sync/pause", methods=["POST"])
def api_sync_pause():
    _ensure_sync_dirs()
    try:
        payload = request.get_json(silent=True) or {}
        paused = bool(payload.get("paused", True))
        s = _default_sync_settings()
        if os.path.exists(SYNC_SETTINGS):
            with open(SYNC_SETTINGS, "r", encoding="utf-8") as f:
                s.update(json.load(f) or {})
        s["paused"] = paused
        with open(SYNC_SETTINGS, "w", encoding="utf-8") as f:
            json.dump(s, f, indent=2)
        return jsonify({"ok": True, "paused": paused})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
@app.route("/api/sync/test", methods=["POST"])
def api_sync_test():
    """
    Test connection settings without saving them.
    If JSON payload is provided, validate that. Otherwise validate stored settings.
    """
    try:
        _ensure_sync_dirs()
        d = _default_sync_settings()

        payload = None
        try:
            payload = request.get_json(silent=True)
        except Exception:
            payload = None

        if payload:
            d.update({
                "webdav_url": str(payload.get("webdav_url","")).strip(),
                "remote_path": str(payload.get("remote_path","")).strip(),
                "username": str(payload.get("username","")).strip(),
                "password": str(payload.get("password","")),
            })
        elif os.path.exists(SYNC_SETTINGS):
            with open(SYNC_SETTINGS, "r", encoding="utf-8") as f:
                d.update(json.load(f) or {})

        url = d.get("webdav_url","")
        if not (url.startswith("http://") or url.startswith("https://")):
            return jsonify({"ok": False, "error": "Invalid WebDAV URL"})
        if not d.get("remote_path","").strip():
            return jsonify({"ok": False, "error": "Remote folder is empty"})
        if not d.get("username","").strip():
            return jsonify({"ok": False, "error": "Username is empty"})
        if not d.get("password",""):
            return jsonify({"ok": False, "error": "Password / token is empty"})

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.get("/api/notes/<note_id>/pdf")
def api_note_pdf(note_id: str):
    """
    Generate a simple PDF for a note and return it as a download.
    """
    ensure_dirs()
    content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "not_found"}), 404
    if deleted:
        return jsonify({"error": "note_deleted"}), 400

    meta = load_json(meta_path)
    title = (meta.get("title") or "").strip()
    filename = (meta.get("filename") or f"{note_id}.md").strip()
    display = title if title else filename

    safe_base = re.sub(r'[^A-Za-z0-9._-]+', "_", display)[:120].strip("_") or "note"
    out_name = safe_base + ".pdf"

    content = ""
    if content_path and content_path.exists():
        content = content_path.read_text(encoding="utf-8", errors="ignore")

    buf = io.BytesIO()
    try:
        c = canvas.Canvas(buf, pagesize=A4)
        width, height = A4

        font_name = "Courier"
        font_size = 10
        title_font = 14

        left = 18 * mm
        right = 18 * mm
        top = 18 * mm
        bottom = 18 * mm
        max_w = width - left - right

        y = height - top

        c.setFont("Helvetica-Bold", title_font)
        c.drawString(left, y, display)
        y -= 10 * mm

        c.setFont(font_name, font_size)
        line_height = 4.2 * mm

        wrapped = _pdf_wrap_lines(content, c, max_w, font_name, font_size)
        for line in wrapped:
            if y < bottom:
                c.showPage()
                y = height - top
                c.setFont(font_name, font_size)
            c.drawString(left, y, line)
            y -= line_height

        c.save()
        buf.seek(0)
    except Exception as e:
        return jsonify({"error": "pdf_failed", "detail": str(e)}), 500

    return send_file(
        buf,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=out_name,
    )

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8060"))
    app.run(host="0.0.0.0", port=port)

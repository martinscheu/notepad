from __future__ import annotations

import base64
import fcntl
import io
import json
import logging
import logging.handlers
import time
import os
import re
import shutil
import unicodedata
import zipfile
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Dict, List, Optional, Tuple

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes


# --- Structured JSON logging ---
class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: Dict[str, Any] = {
            "ts": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "level": record.levelname,
            "msg": record.getMessage(),
        }
        if hasattr(record, "event"):
            entry["event"] = record.event  # type: ignore[attr-defined]
        if hasattr(record, "extra_data"):
            entry.update(record.extra_data)  # type: ignore[attr-defined]
        if record.exc_info and record.exc_info[1]:
            entry["error"] = str(record.exc_info[1])
        return json.dumps(entry, ensure_ascii=False)


def _setup_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    # Quiet noisy libraries
    logging.getLogger("werkzeug").setLevel(logging.WARNING)


_setup_logging()
log = logging.getLogger("stickynotes")

from flask import Flask, jsonify, request, send_file, send_from_directory
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Preformatted
try:
    import yaml
except Exception:
    yaml = None
try:
    import markdown as mdlib
except Exception:
    mdlib = None

FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"



_CITE_START = "\ue200"
_CITE_END = "\ue201"
_CITE_SEP = "\ue202"
_CITE_RE = re.compile(re.escape(_CITE_START) + "cite" + re.escape(_CITE_SEP) + r"(.+?)" + re.escape(_CITE_END))


def _normalize_citations(text: str) -> str:
    if not text:
        return text
    def repl(match: re.Match) -> str:
        inner = match.group(1) or ""
        parts = [p for p in inner.split(_CITE_SEP) if p]
        if not parts:
            return "[cite]"
        return "[cite: " + ", ".join(parts) + "]"
    out = _CITE_RE.sub(repl, text)
    return out.replace(_CITE_START, "").replace(_CITE_SEP, "").replace(_CITE_END, "")


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


class _MdBlockParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.blocks: List[Dict[str, Any]] = []
        self.cur_tag: Optional[str] = None
        self.cur = ""
        self.in_pre = False
        self.list_stack: List[Dict[str, Any]] = []

    def handle_starttag(self, tag, attrs):
        if tag in ("ul", "ol"):
            self.list_stack.append({"type": tag, "index": 0})
            return
        if tag in ("p", "h1", "h2", "h3", "h4", "h5", "h6", "li"):
            self.cur_tag = tag
            self.cur = ""
            return
        if tag == "pre":
            self.in_pre = True
            self.cur_tag = "pre"
            self.cur = ""
            return
        # inline tags
        if tag == "strong":
            self.cur += "<b>"
        elif tag == "em":
            self.cur += "<i>"
        elif tag == "code":
            if not self.in_pre:
                self.cur += "<font face=\"Courier\">"

    def handle_endtag(self, tag):
        if tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
            return
        if tag == "strong":
            self.cur += "</b>"
            return
        if tag == "em":
            self.cur += "</i>"
            return
        if tag == "code":
            if not self.in_pre:
                self.cur += "</font>"
            return
        if tag == "pre":
            self.blocks.append({"type": "pre", "text": self.cur})
            self.in_pre = False
            self.cur_tag = None
            self.cur = ""
            return
        if tag in ("p", "h1", "h2", "h3", "h4", "h5", "h6", "li"):
            if tag == "li":
                bullet = None
                if self.list_stack:
                    top = self.list_stack[-1]
                    if top["type"] == "ol":
                        top["index"] += 1
                        bullet = f"{top['index']}."
                    else:
                        bullet = "•"
                self.blocks.append({"type": "li", "text": self.cur, "bullet": bullet})
            else:
                self.blocks.append({"type": tag, "text": self.cur})
            self.cur_tag = None
            self.cur = ""

    def handle_data(self, data):
        if not self.cur_tag:
            return
        if self.in_pre:
            self.cur += data
        else:
            self.cur += (data or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _markdown_to_flowables(md_text: str) -> List[Any]:
    def normalize_lists(text: str) -> str:
        if not text:
            return text
        lines = text.replace("\r\n", "\n").split("\n")
        out: List[str] = []
        in_code = False
        list_re = re.compile(r"^\s*(?:[-*]|\d+\.)\s+")
        for line in lines:
            if line.strip().startswith("```"):
                in_code = not in_code
                out.append(line)
                continue
            if not in_code and list_re.match(line):
                if out:
                    prev = out[-1]
                    if prev.strip() and not list_re.match(prev):
                        out.append("")
            out.append(line)
        return "\n".join(out)

    if mdlib is None:
        styles = getSampleStyleSheet()
        code_style = styles["Code"]
        max_width = A4[0] - (18 * mm * 2)
        wrapped = "\n".join(_pdf_wrap_lines(md_text or "", None, max_width, code_style.fontName, code_style.fontSize))
        return [Preformatted(wrapped, code_style)]
    md_text = normalize_lists(md_text or "")
    html = mdlib.markdown(md_text or "", extensions=["fenced_code", "tables"])
    parser = _MdBlockParser()
    parser.feed(html)
    styles = getSampleStyleSheet()
    flow: List[Any] = []

    h1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=18, spaceAfter=8)
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=15, spaceAfter=6)
    h3 = ParagraphStyle("H3", parent=styles["Heading3"], fontSize=13, spaceAfter=6)
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontSize=10.5,
        leading=13,
        splitLongWords=True,
        wordWrap="CJK",
    )
    code_style = styles["Code"]
    max_width = A4[0] - (18 * mm * 2)

    for b in parser.blocks:
        t = b.get("type")
        text = b.get("text", "")
        if t == "h1":
            flow.append(Paragraph(text, h1))
        elif t == "h2":
            flow.append(Paragraph(text, h2))
        elif t == "h3":
            flow.append(Paragraph(text, h3))
        elif t in ("h4", "h5", "h6"):
            flow.append(Paragraph(text, body))
        elif t == "p":
            flow.append(Paragraph(text, body))
        elif t == "li":
            flow.append(Paragraph(text, body, bulletText=b.get("bullet") or "•"))
        elif t == "pre":
            wrapped = "\n".join(_pdf_wrap_lines(text or "", None, max_width, code_style.fontName, code_style.fontSize))
            flow.append(Preformatted(wrapped, code_style))
        flow.append(Spacer(1, 6))

    if not flow:
        flow.append(Paragraph("", body))
    return flow


def _make_numbered_canvas(
    header_left: str,
    header_right: str,
    footer_tpl: str,
    footer_left_label: str = "",
    footer_left_fill=None,
    footer_left_text=None,
    footer_left_border=None,
):
    class NumberedCanvas(canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            num_pages = len(self._saved_page_states) + 1
            for state in self._saved_page_states:
                self.__dict__.update(state)
                self._draw_header_footer(num_pages)
                super().showPage()
            self._draw_header_footer(num_pages)
            super().save()

        def _draw_header_footer(self, page_count: int):
            page = self._pageNumber
            width, height = self._pagesize
            margin = 18 * mm
            y_header = height - margin + 6
            y_footer = margin - 12

            if header_left or header_right:
                self.setFont("Helvetica", 9)
                if header_left:
                    self.drawString(margin, y_header, header_left)
                if header_right:
                    self.drawRightString(width - margin, y_header, header_right)

            if footer_left_label:
                font_name = "Helvetica-Bold"
                font_size = 8
                padding_x = 4
                padding_y = 2
                text_width = pdfmetrics.stringWidth(footer_left_label, font_name, font_size)
                box_w = text_width + (padding_x * 2)
                box_h = font_size + (padding_y * 2)
                box_x = margin
                box_y = y_footer - padding_y - 1
                self.saveState()
                if footer_left_fill is not None:
                    self.setFillColor(footer_left_fill)
                if footer_left_border is not None:
                    self.setStrokeColor(footer_left_border)
                    stroke = 1
                else:
                    stroke = 0
                self.rect(box_x, box_y, box_w, box_h, fill=1, stroke=stroke)
                if footer_left_text is not None:
                    self.setFillColor(footer_left_text)
                self.setFont(font_name, font_size)
                self.drawString(box_x + padding_x, box_y + padding_y, footer_left_label)
                self.restoreState()

            self.setFont("Helvetica", 9)
            footer_text = footer_tpl.format(page=page, pages=page_count)
            self.drawCentredString(width / 2, y_footer, footer_text)

    return NumberedCanvas
app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="/static")


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(FRONTEND_DIR, "favicon.ico", mimetype="image/x-icon")

# ---------- Config ----------
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))

NOTES_DIR = DATA_DIR / "notes"
TRASH_DIR = DATA_DIR / "trash"
JOURNAL_DIR = DATA_DIR / "journal"
EXPORTS_DIR = DATA_DIR / "exports"
INDEX_PATH = DATA_DIR / "index.json"
PDF_SETTINGS_PATH = CONFIG_DIR / "pdf_settings.json"
ENCRYPTION_SETTINGS_PATH = CONFIG_DIR / "encryption.json"

SAFE_TITLE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_dirs() -> None:
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    JOURNAL_DIR.mkdir(parents=True, exist_ok=True)
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    _maybe_migrate_pdf_settings()


# ---------- Encryption helpers ----------
_ENCRYPTION_SALT = b"stickynotes-encryption-v1"
_fernet_cache: Optional[Fernet] = None
_fernet_passphrase_hash: Optional[str] = None


def _derive_fernet_key(passphrase: str) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_ENCRYPTION_SALT,
        iterations=480_000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(passphrase.encode("utf-8")))
    return key


def _load_encryption_settings() -> Dict[str, Any]:
    if not ENCRYPTION_SETTINGS_PATH.exists():
        return {}
    try:
        return json.loads(ENCRYPTION_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_encryption_settings(data: Dict[str, Any]) -> None:
    ENCRYPTION_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(ENCRYPTION_SETTINGS_PATH, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def _invalidate_fernet_cache() -> None:
    global _fernet_cache, _fernet_passphrase_hash
    _fernet_cache = None
    _fernet_passphrase_hash = None


def _get_fernet() -> Optional[Fernet]:
    global _fernet_cache, _fernet_passphrase_hash
    settings = _load_encryption_settings()
    passphrase = settings.get("passphrase", "")
    if not passphrase:
        _fernet_cache = None
        _fernet_passphrase_hash = None
        return None
    # Cache: only re-derive if passphrase changed
    if _fernet_cache is not None and _fernet_passphrase_hash == passphrase:
        return _fernet_cache
    key = _derive_fernet_key(passphrase)
    _fernet_cache = Fernet(key)
    _fernet_passphrase_hash = passphrase
    return _fernet_cache


def encrypt_content(plaintext: str) -> str:
    f = _get_fernet()
    if f is None:
        raise ValueError("No encryption key configured")
    return f.encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_content(ciphertext: str) -> str:
    f = _get_fernet()
    if f is None:
        raise ValueError("No encryption key configured")
    return f.decrypt(ciphertext.encode("ascii")).decode("utf-8")


def read_note_content(content_path: Path, meta: Dict[str, Any]) -> str:
    raw = content_path.read_text(encoding="utf-8", errors="ignore")
    if meta.get("encrypted"):
        try:
            return decrypt_content(raw.strip())
        except (InvalidToken, ValueError, Exception):
            return "[Decryption failed — wrong passphrase or corrupt data]"
    return raw


def write_note_content(content_path: Path, content: str, meta: Dict[str, Any]) -> None:
    if meta.get("encrypted"):
        data = encrypt_content(content)
    else:
        data = content
    atomic_write_text(content_path, data)


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


_UMLAUT_MAP = str.maketrans({
    "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
    "Ä": "Ae", "Ö": "Oe", "Ü": "Ue",
})


def _transliterate(text: str) -> str:
    """Replace German umlauts explicitly, then NFKD-decompose other accented chars."""
    text = text.translate(_UMLAUT_MAP)
    # Decompose accented characters (é→e+combining-accent) then strip combining marks
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in nfkd if unicodedata.category(ch) != "Mn")


def slugify_title(title: str) -> str:
    title = title.strip()
    if not title:
        return ""
    title = _transliterate(title)
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


def _default_pdf_meta() -> Dict[str, Any]:
    return {
        "author": "",
        "company": "",
        "version": "",
        "date": "",
        "use_export_date": True,
        "tlp": "AMBER",
    }


def _normalize_pdf_meta(data: Any) -> Dict[str, Any]:
    d = _default_pdf_meta()
    if not isinstance(data, dict):
        return d
    d["author"] = str(data.get("author", "")).strip()
    d["company"] = str(data.get("company", "")).strip()
    d["version"] = str(data.get("version", "")).strip()
    d["date"] = str(data.get("date", "")).strip()
    d["use_export_date"] = bool(data.get("use_export_date", True))
    tlp = str(data.get("tlp", "")).strip().upper()
    if tlp not in ("CLEAR", "GREEN", "AMBER", "AMBER+STRICT", "RED"):
        tlp = "AMBER"
    d["tlp"] = tlp
    return d


def _tlp_style(tlp: str):
    tlp = (tlp or "").upper()
    if tlp == "CLEAR":
        return (colors.white, colors.black, colors.black)
    if tlp == "GREEN":
        return (colors.HexColor("#24a148"), colors.white, None)
    if tlp == "AMBER+STRICT":
        return (colors.HexColor("#e6ab00"), colors.black, None)
    if tlp == "RED":
        return (colors.HexColor("#da1e28"), colors.white, None)
    return (colors.HexColor("#f1c21b"), colors.black, None)


_PDF_MIGRATION_DONE = False


def _maybe_migrate_pdf_settings() -> None:
    global _PDF_MIGRATION_DONE
    if _PDF_MIGRATION_DONE:
        return
    _PDF_MIGRATION_DONE = True

    if not PDF_SETTINGS_PATH.exists():
        return
    try:
        data = json.loads(PDF_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(data, dict):
        return

    base = _default_pdf_meta()
    base["author"] = str(data.get("author", "")).strip()
    base["version"] = str(data.get("version", "")).strip()

    needs_migration = False
    for scan_dir in [NOTES_DIR, JOURNAL_DIR]:
        for meta_path in scan_dir.glob("*.json"):
            try:
                meta = load_json(meta_path)
            except Exception:
                continue
            if not isinstance(meta.get("pdf"), dict):
                needs_migration = True
                break
        if needs_migration:
            break
    if not needs_migration:
        return

    for meta_path in list(NOTES_DIR.glob("*.json")) + list(JOURNAL_DIR.glob("*.json")):
        try:
            meta = load_json(meta_path)
        except Exception:
            continue
        if isinstance(meta.get("pdf"), dict):
            continue
        meta["pdf"] = dict(base)
        save_json(meta_path, meta)


_INDEX_LOCK_PATH = DATA_DIR / ".index.lock"


class _index_lock:
    """Context manager for file-based locking around index operations."""
    def __enter__(self):
        _INDEX_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        self._f = open(_INDEX_LOCK_PATH, "w")
        fcntl.flock(self._f.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self._f.fileno(), fcntl.LOCK_UN)
        self._f.close()
        return False


def rebuild_index() -> List[Dict[str, Any]]:
    with _index_lock():
        metas = []
        for base_dir, deleted in [(NOTES_DIR, False), (JOURNAL_DIR, False), (TRASH_DIR, True)]:
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
    with _index_lock():
        metas = load_index()
        if metas is None:
            # Fall through to rebuild (which acquires its own lock via reentrant path)
            pass
        else:
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
            return
    # Outside lock: rebuild if index was missing
    rebuild_index()


def find_note_files_by_id(note_id: str) -> Tuple[Optional[Path], Optional[Path], bool]:
    for base_dir, deleted in [(NOTES_DIR, False), (JOURNAL_DIR, False), (TRASH_DIR, True)]:
        for meta in base_dir.glob("*.json"):
            try:
                m = load_json(meta)
            except Exception:
                continue
            if m.get("id") == note_id:
                # content may be md, txt, yaml, or yml
                content = None
                for _ext in (".md", ".txt", ".yaml", ".yml"):
                    candidate = meta.with_suffix(_ext)
                    if candidate.exists():
                        content = candidate
                        break
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
                    txt = read_note_content(content_path, m).lower()
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
        "subject": "",
        "pdf": _default_pdf_meta(),
        "pinned": False,
        "deleted": False,
        "encrypted": False,
    }
    save_json(meta_path, meta)
    update_index_meta(meta)
    log.info("Note created", extra={"event": "note_created", "extra_data": {"note_id": note_id, "filename": content_path.name}})
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


@app.route("/api/notes/<note_id>/pdf-settings", methods=["GET"])
def api_get_note_pdf_settings(note_id: str):
    ensure_dirs()
    _content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404
    if deleted:
        return jsonify({"error": "Note is deleted"}), 400
    meta = load_json(meta_path)
    pdf = _normalize_pdf_meta(meta.get("pdf", {}))
    return jsonify(pdf)


@app.route("/api/notes/<note_id>/pdf-settings", methods=["PUT"])
def api_set_note_pdf_settings(note_id: str):
    ensure_dirs()
    body = request.get_json(silent=True) or {}
    _content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404
    if deleted:
        return jsonify({"error": "Note is deleted"}), 400
    meta = load_json(meta_path)
    pdf = _normalize_pdf_meta(body)
    meta["pdf"] = pdf
    meta["updated"] = utc_now_iso()
    meta["rev"] = int(meta.get("rev", 0)) + 1
    save_json(meta_path, meta)
    update_index_meta(meta)

    # TLP:RED auto-encryption
    if pdf.get("tlp") == "RED" and not meta.get("encrypted") and _get_fernet() is not None:
        try:
            content = ""
            if _content_path and _content_path.exists():
                content = read_note_content(_content_path, {"encrypted": False})
            meta["encrypted"] = True
            meta["updated"] = utc_now_iso()
            meta["rev"] = int(meta.get("rev", 0)) + 1
            write_note_content(_content_path, content, meta)
            save_json(meta_path, meta)
            update_index_meta(meta)
        except Exception:
            pass

    return jsonify({"ok": True, "pdf": pdf, "updated": meta["updated"], "rev": meta["rev"], "meta": meta})


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
        if ext not in ("md", "txt", "yaml", "yml"):
            errors.append({"file": safe_name, "error": "Unsupported file type"})
            continue

        try:
            raw = f.read()
            text = _normalize_citations(raw.decode("utf-8", errors="replace"))
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
            "subject": "",
            "pdf": _default_pdf_meta(),
            "pinned": False,
            "deleted": False,
            "encrypted": False,
        }
        save_json(meta_path, meta)
        update_index_meta(meta)
        created.append(meta)

    if not created:
        return jsonify({"error": "No valid files imported", "errors": errors}), 400
    log.info("Import completed", extra={"event": "import", "extra_data": {"count": len(created), "errors": len(errors)}})
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
        content = read_note_content(content_path, meta)
    return jsonify({"meta": meta, "content": content})


@app.route("/api/notes/<note_id>/content", methods=["PUT"])
def api_save_content(note_id: str):
    ensure_dirs()
    body = request.get_json(force=True)
    content = _normalize_citations(body.get("content", ""))
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
        content_path = meta_path.parent / fn

    write_note_content(content_path, content, meta)
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
    subject = body.get("subject", None)

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

        new_content = meta_path.parent / f"{new_basename}.{ext}"
        new_meta = meta_path.parent / f"{new_basename}.json"

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

    if subject is not None:
        meta["subject"] = str(subject).strip()
        meta["updated"] = utc_now_iso()
        meta["rev"] = int(meta.get("rev", 0)) + 1

    save_json(meta_path, meta)
    update_index_meta(meta)
    log.info("Note metadata updated", extra={"event": "note_meta_updated", "extra_data": {"note_id": note_id, "title": meta.get("title", "")}})
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
    log.info("Note deleted", extra={"event": "note_deleted", "extra_data": {"note_id": note_id}})

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

    restore_dir = JOURNAL_DIR if meta.get("subject") == "Journal" else NOTES_DIR
    target_meta = restore_dir / meta_path.name
    target_content = restore_dir / (content_path.name if content_path else meta.get("filename", ""))

    if content_path and content_path.exists():
        shutil.move(str(content_path), str(target_content))
    shutil.move(str(meta_path), str(target_meta))
    save_json(target_meta, meta)
    update_index_meta(meta)
    log.info("Note restored", extra={"event": "note_restored", "extra_data": {"note_id": note_id}})

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
        content = read_note_content(content_path, meta)

    title = (meta.get("title") or "").strip()
    if title:
        safe = SAFE_TITLE_RE.sub("-", _transliterate(title)).strip("-")[:80] or "note"
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
        for base_dir, folder in [(NOTES_DIR, "notes"), (JOURNAL_DIR, "journal"), (TRASH_DIR, "trash")]:
            if base_dir == TRASH_DIR and not include_deleted:
                continue
            for p in base_dir.iterdir():
                if p.is_file() and p.suffix == ".json":
                    z.write(p, arcname=f"{folder}/{p.name}")
                elif p.is_file() and p.suffix in (".md", ".txt", ".yaml", ".yml"):
                    # Decrypt content for export
                    meta_path = p.with_suffix(".json")
                    meta = {}
                    if meta_path.exists():
                        try:
                            meta = load_json(meta_path)
                        except Exception:
                            pass
                    if meta.get("encrypted"):
                        try:
                            plaintext = read_note_content(p, meta)
                            z.writestr(f"{folder}/{p.name}", plaintext.encode("utf-8"))
                        except Exception:
                            z.write(p, arcname=f"{folder}/{p.name}")
                    else:
                        z.write(p, arcname=f"{folder}/{p.name}")

    buf.seek(0)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    log.info("Export all triggered", extra={"event": "export_all", "extra_data": {"include_deleted": include_deleted}})
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
                meta = {}
                if meta_path and meta_path.exists():
                    try:
                        meta = load_json(meta_path)
                    except Exception:
                        pass
                if meta.get("encrypted"):
                    try:
                        plaintext = read_note_content(content_path, meta)
                        zf.writestr(content_path.name, plaintext.encode("utf-8"))
                    except Exception:
                        zf.write(content_path, arcname=content_path.name)
                else:
                    zf.write(content_path, arcname=content_path.name)

    mem.seek(0)
    log.info("Export selected triggered", extra={"event": "export_selected", "extra_data": {"count": len(ids)}})
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
            if d.get("password"):
                d["password"] = "********"
            return jsonify(d)
        except Exception:
            return jsonify(_default_sync_settings())
    return jsonify(_default_sync_settings())

@app.route("/api/sync/settings", methods=["POST"])
def api_set_sync_settings():
    _ensure_sync_dirs()
    try:
        payload = request.get_json(force=True) or {}
        # Preserve existing password if masked value sent back
        password = str(payload.get("password", ""))
        if password == "********":
            existing = _default_sync_settings()
            if os.path.exists(SYNC_SETTINGS):
                try:
                    with open(SYNC_SETTINGS, "r", encoding="utf-8") as f:
                        existing.update(json.load(f) or {})
                except Exception:
                    pass
            password = existing.get("password", "")
        d = _default_sync_settings()
        d.update({
            "enabled": bool(payload.get("enabled", False)),
            "webdav_url": str(payload.get("webdav_url","")).strip(),
            "remote_path": str(payload.get("remote_path","")).strip(),
            "username": str(payload.get("username","")).strip(),
            "password": password,
            "mode": str(payload.get("mode","push")).strip() or "push",
            "interval_s": int(payload.get("interval_s", 60) or 60),
            "no_deletes": bool(payload.get("no_deletes", True)),
        })
        if d["interval_s"] < 10:
            d["interval_s"] = 10
        with open(SYNC_SETTINGS, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2)
        log.info("Sync settings saved", extra={"event": "sync_settings_saved", "extra_data": {"enabled": d["enabled"], "mode": d["mode"], "webdav_url": d["webdav_url"]}})
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


# ---------- Encryption settings API ----------
@app.route("/api/encryption/settings", methods=["GET"])
def api_get_encryption_settings():
    settings = _load_encryption_settings()
    has_key = bool(settings.get("passphrase", ""))
    encrypted_count = 0
    if has_key:
        metas = list_metas(include_deleted=False)
        encrypted_count = sum(1 for m in metas if m.get("encrypted"))
    return jsonify({"has_key": has_key, "encrypted_count": encrypted_count})


@app.route("/api/encryption/settings", methods=["POST"])
def api_set_encryption_settings():
    body = request.get_json(silent=True) or {}
    passphrase = str(body.get("passphrase", "")).strip()
    if not passphrase:
        return jsonify({"error": "Passphrase cannot be empty"}), 400
    old_settings = _load_encryption_settings()
    old_passphrase = old_settings.get("passphrase", "")
    had_key = bool(old_passphrase)
    if had_key:
        current = str(body.get("current_passphrase", "")).strip()
        if current != old_passphrase:
            return jsonify({"error": "Current passphrase is incorrect"}), 403
    key_changed = had_key and old_passphrase != passphrase
    _save_encryption_settings({"passphrase": passphrase})
    _invalidate_fernet_cache()
    log.info("Encryption passphrase saved", extra={"event": "encryption_settings_saved"})
    result: Dict[str, Any] = {"ok": True}
    if key_changed:
        result["warning"] = "key_changed"
    return jsonify(result)


@app.route("/api/encryption/settings", methods=["DELETE"])
def api_delete_encryption_settings():
    """Disable encryption: decrypt all encrypted notes, then remove the key."""
    body = request.get_json(silent=True) or {}
    current = str(body.get("current_passphrase", "")).strip()
    old_settings = _load_encryption_settings()
    old_passphrase = old_settings.get("passphrase", "")
    if not old_passphrase:
        return jsonify({"error": "No encryption key configured"}), 400
    if current != old_passphrase:
        return jsonify({"error": "Passphrase is incorrect"}), 403

    # Decrypt all encrypted notes
    ensure_dirs()
    decrypted = 0
    errors = 0
    for base_dir in [NOTES_DIR, JOURNAL_DIR, TRASH_DIR]:
        for meta_path in base_dir.glob("*.json"):
            try:
                meta = load_json(meta_path)
            except Exception:
                continue
            if not meta.get("encrypted"):
                continue
            note_id = meta.get("id", "")
            fn = meta.get("filename", "")
            content_path = None
            for _ext in (".md", ".txt", ".yaml", ".yml"):
                candidate = meta_path.with_suffix(_ext)
                if candidate.exists():
                    content_path = candidate
                    break
            if content_path and content_path.exists():
                try:
                    plaintext = read_note_content(content_path, meta)
                    meta["encrypted"] = False
                    atomic_write_text(content_path, plaintext)
                    save_json(meta_path, meta)
                    update_index_meta(meta)
                    decrypted += 1
                except Exception:
                    errors += 1
            else:
                meta["encrypted"] = False
                save_json(meta_path, meta)
                update_index_meta(meta)

    # Remove the key
    _save_encryption_settings({})
    _invalidate_fernet_cache()
    log.info("Encryption disabled", extra={"event": "encryption_disabled", "extra_data": {"decrypted": decrypted, "errors": errors}})
    result: Dict[str, Any] = {"ok": True, "decrypted": decrypted}
    if errors:
        result["errors"] = errors
        result["warning"] = f"{errors} note(s) could not be decrypted"
    return jsonify(result)


@app.route("/api/notes/<note_id>/encrypt", methods=["PUT"])
def api_toggle_encryption(note_id: str):
    ensure_dirs()
    body = request.get_json(silent=True) or {}
    want_encrypted = bool(body.get("encrypted", False))

    content_path, meta_path, deleted = find_note_files_by_id(note_id)
    if not meta_path:
        return jsonify({"error": "Not found"}), 404
    if deleted:
        return jsonify({"error": "Note is deleted"}), 400

    meta = load_json(meta_path)
    is_encrypted = bool(meta.get("encrypted"))

    if want_encrypted == is_encrypted:
        return jsonify({"ok": True, "encrypted": is_encrypted})

    if want_encrypted and _get_fernet() is None:
        return jsonify({"error": "No encryption key configured. Set a passphrase in Settings first."}), 400

    # Read current content (decrypting if needed)
    content = ""
    if content_path and content_path.exists():
        content = read_note_content(content_path, meta)

    # Flip the flag
    meta["encrypted"] = want_encrypted
    meta["updated"] = utc_now_iso()
    meta["rev"] = int(meta.get("rev", 0)) + 1

    # Re-write content in new state
    if content_path is None:
        fn = meta.get("filename")
        if not fn:
            return jsonify({"error": "Corrupt note (missing filename)"}), 500
        content_path = meta_path.parent / fn

    write_note_content(content_path, content, meta)
    save_json(meta_path, meta)
    update_index_meta(meta)
    log.info("Note encryption toggled", extra={"event": "note_encrypt_toggle", "extra_data": {"note_id": note_id, "encrypted": want_encrypted}})
    return jsonify({"ok": True, "encrypted": want_encrypted, "meta": meta})


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

    safe_base = re.sub(r'[^A-Za-z0-9._-]+', "_", _transliterate(display))[:120].strip("_") or "note"
    out_name = safe_base + ".pdf"

    content = ""
    if content_path and content_path.exists():
        content = read_note_content(content_path, meta)

    fmt = (request.args.get("format") or "md").strip().lower()
    if fmt not in ("md", "txt"):
        fmt = "md"

    pdf_meta = _normalize_pdf_meta(meta.get("pdf", {}))
    author = (pdf_meta.get("author") or "").strip()
    company = (pdf_meta.get("company") or "").strip()
    version = (pdf_meta.get("version") or "").strip()
    date_str = (pdf_meta.get("date") or "").strip()
    use_export_date = bool(pdf_meta.get("use_export_date", True))
    tlp = (pdf_meta.get("tlp") or "AMBER").strip().upper()
    header_left = display
    header_right_parts: List[str] = []
    if company:
        header_right_parts.append(company)
    if author:
        header_right_parts.append(author)
    if version:
        header_right_parts.append(version if version.lower().startswith("v") else f"v{version}")
    if use_export_date:
        header_right_parts.append(datetime.now().date().isoformat())
    elif date_str:
        header_right_parts.append(date_str)
    header_right = " • ".join([p for p in header_right_parts if p])
    tlp_label = f"TLP: {tlp}"
    tlp_fill, tlp_text, tlp_border = _tlp_style(tlp)

    buf = io.BytesIO()
    try:
        doc = SimpleDocTemplate(
            buf,
            pagesize=A4,
            leftMargin=18 * mm,
            rightMargin=18 * mm,
            topMargin=24 * mm,
            bottomMargin=20 * mm,
            title=display,
        )
        flow: List[Any] = []
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle("PdfTitle", parent=styles["Heading1"], fontSize=16, spaceAfter=10)
        flow.append(Paragraph(display, title_style))
        if fmt == "txt":
            code_style = styles["Code"]
            max_width = A4[0] - (18 * mm * 2)
            wrapped = "\n".join(_pdf_wrap_lines(content or "", None, max_width, code_style.fontName, code_style.fontSize))
            flow.append(Preformatted(wrapped, code_style))
        else:
            flow.extend(_markdown_to_flowables(content or ""))
        canvas_maker = _make_numbered_canvas(
            header_left,
            header_right,
            "Page {page} of {pages}",
            footer_left_label=tlp_label,
            footer_left_fill=tlp_fill,
            footer_left_text=tlp_text,
            footer_left_border=tlp_border,
        )
        doc.build(flow, canvasmaker=canvas_maker)
        buf.seek(0)
    except Exception as e:
        log.warning("PDF generation failed", extra={"event": "pdf_failed", "extra_data": {"note_id": note_id, "error": str(e)}})
        return jsonify({"error": "pdf_failed", "detail": str(e)}), 500

    log.info("PDF generated", extra={"event": "pdf_generated", "extra_data": {"note_id": note_id, "title": display}})
    return send_file(
        buf,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=out_name,
    )

# ---------- Journal endpoints ----------
import calendar


@app.route("/api/journal/today", methods=["POST"])
def api_journal_today():
    ensure_dirs()
    body = request.get_json(silent=True) or {}
    date_str = (body.get("date") or "").strip()
    if not date_str:
        return jsonify({"error": "Missing date"}), 400
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "Invalid date format (expected YYYY-MM-DD)"}), 400

    day_name = calendar.day_name[dt.weekday()]
    title = f"{date_str} {day_name}"

    # Search JOURNAL_DIR for existing note with that title
    for meta_path in JOURNAL_DIR.glob("*.json"):
        try:
            m = load_json(meta_path)
        except Exception:
            continue
        if m.get("title") == title and not m.get("deleted"):
            return jsonify({**m, "created": False})

    # Create new journal note
    created_dt = datetime.now(timezone.utc).replace(microsecond=0)
    for _ in range(20):
        note_id = gen_id()
        basename = mk_basename(note_id, user_title=title, created_dt=created_dt)
        content_path = JOURNAL_DIR / f"{basename}.md"
        meta_path = JOURNAL_DIR / f"{basename}.json"
        if not content_path.exists() and not meta_path.exists():
            break
    else:
        return jsonify({"error": "Failed to allocate note id"}), 500

    initial_content = f"# {title}\n\n"
    atomic_write_text(content_path, initial_content)
    created_iso = created_dt.isoformat().replace("+00:00", "Z")
    meta = {
        "id": note_id,
        "created": created_iso,
        "updated": created_iso,
        "rev": 1,
        "filename": content_path.name,
        "title": title,
        "subject": "Journal",
        "pdf": _default_pdf_meta(),
        "pinned": False,
        "deleted": False,
        "encrypted": False,
    }
    save_json(meta_path, meta)
    update_index_meta(meta)
    log.info("Journal note created", extra={"event": "journal_created", "extra_data": {"note_id": note_id, "title": title}})
    return jsonify({**meta, "created": True}), 201


_JOURNAL_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\s+\w+")


@app.route("/api/journal/aggregate", methods=["GET"])
def api_journal_aggregate():
    ensure_dirs()
    year = request.args.get("year", "").strip()
    month = request.args.get("month", "").strip()
    if not year:
        return jsonify({"error": "Missing year parameter"}), 400

    entries: List[Dict[str, Any]] = []
    for meta_path in JOURNAL_DIR.glob("*.json"):
        try:
            m = load_json(meta_path)
        except Exception:
            continue
        if m.get("deleted"):
            continue
        title = m.get("title", "")
        match = _JOURNAL_DATE_RE.match(title)
        if not match:
            continue
        y, mo, d = match.group(1), match.group(2), match.group(3)
        if y != year:
            continue
        if month and mo != month:
            continue
        # Read content
        content = ""
        note_id = m.get("id", "")
        content_path, _, _ = find_note_files_by_id(note_id)
        if content_path and content_path.exists():
            content = read_note_content(content_path, m)
        entries.append({
            "date": f"{y}-{mo}-{d}",
            "title": title,
            "content": content,
            "id": note_id,
        })

    entries.sort(key=lambda e: e["date"])
    period = f"{year}-{month}" if month else year
    return jsonify({"period": period, "entries": entries})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8060"))
    app.run(host="0.0.0.0", port=port)

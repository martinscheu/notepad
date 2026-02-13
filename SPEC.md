# Sticky Notes Web App – Specification

## 1. Purpose

A lightweight, self-hosted web application for personal notes, CLI snippets, and small Markdown texts.

Design goals:
- Extremely low friction (autosave-first, no login)
- Fast keyboard-driven workflow
- Notes stored as real files on disk
- Clear, distraction-free UI
- Stable and boring (in the good sense)

Target environment:
- Home lab
- LAN / VPN access only
- Desktop-first usage

---

## 2. User Model & Access

- Single user
- No authentication
- No sensitive data assumed
- Accessible only via:
  - Local LAN
  - VPN into LAN
- No internet exposure assumed

---

## 3. Storage Model

### 3.1 Notes

- Notes are stored as files on disk
- Supported formats:
  - `.md` (Markdown)
  - `.txt` (plain text)
- Each note consists of:
  - One content file
  - One metadata sidecar file (`.json`)

### 3.2 Directory Layout

```
/opt/stickynotes/
├── releases/
├── current -> /opt/stickynotes/releases/<version>
├── notes/
│   ├── notes/
│   ├── journal/       # Daily journal entries
│   ├── trash/
│   ├── exports/
│   └── sync/          # WebDAV sync settings & status
└── config/
    ├── config.json
    └── compose.env
```

- Storage root is configurable
- Backend must not read/write outside this directory

---

## 4. Note Identity & Naming

### 4.1 Internal ID

- Each note has a unique, immutable internal ID
- Used for all API operations
- Independent of filename

### 4.2 Filename Format

Default filename:
```
YYYY-MM-DD_HH-MM-SS_<unique-id>.md
```

After user renames:
```
YYYY-MM-DD_HH-MM-SS_<unique-id>_<user-title>.md
```

Rules:
- User title is optional
- Filename is shown in the UI
- Renaming updates:
  - content file
  - metadata reference
- Internal ID never changes

---

## 5. Metadata (.json)

Each note has a sidecar metadata file.

Example:
```json
{
  "id": "ab12cd34",
  "created": "2026-01-06T21:14:33Z",
  "updated": "2026-01-06T21:17:02Z",
  "rev": 12,
  "filename": "2026-01-06_21-14-33_ab12cd34_mytitle.md",
  "title": "mytitle",
  "subject": "Research",
  "pinned": false,
  "deleted": false,
  "pdf": {
    "author": "John Doe",
    "company": "Acme Corp",
    "version": "1.0",
    "date": "2026-01-06",
    "use_export_date": true,
    "tlp": "AMBER"
  }
}
```

Notes:
- `rev` is an integer revision counter, incremented on every save
- Unknown fields must be ignored (forward-compatible)
- `subject` is an optional grouping label shown in the notes list
- `pdf` contains per-note PDF export settings (author, company, version, date, TLP)

---

## 6. Autosave & Concurrency Model

### 6.1 Autosave Trigger

- Autosave on keystroke
- Debounce delay: 500 ms – 1 s
- No explicit "Save" button

### 6.2 Visual Feedback

- Subtle "Saved" indicator
- Display:
  - Last saved timestamp
  - Saving-in-progress state

### 6.3 Multi-Tab Behaviour

- Last writing tab wins
- Each save includes:
  - `base_rev` (client-side last known revision)
- Backend:
  - Always accepts the save
  - Increments `rev`
  - Returns new `rev` + `updated` timestamp

### 6.4 Idle Tab Refresh

- Polling-based
- Idle/open tabs:
  - Poll server every ~5 seconds
  - If remote `rev` > local `rev` and user is not typing:
    - Update content automatically
- No merge UI
- No conflict resolution prompts

---

## 7. User Interface

### 7.1 Layout

- **Top bar** – brand, search, grouped action buttons (New/Upload, Undo/Redo/Preview, Rename/Pin/Download, More/Settings)
- **Sidebar** – notes list grouped by subject, sortable, with bulk actions
- **Tabs bar** – open notes as tabs, save state indicator
- **Editor** – plain textarea with optional preview
- **Panels** – TOC (right side), Search & Replace (right side)

### 7.2 Sorting & Filtering

Sorting:
- Last updated
- Created
- Filename

Filtering:
- Full-text search (filename + content)
- Pinned / unpinned

### 7.3 Subject Grouping

- Notes grouped by subject in the sidebar
- Collapsible groups
- Subject field with autocomplete from existing subjects
- Notes without a subject appear under "Unsorted"

---

## 8. Search

- Full-text search across:
  - Filename
  - Note content
- Case-insensitive
- Instant filtering
- Server-side file scan
- No advanced query syntax

---

## 9. Markdown Handling

- Notes may contain Markdown
- Primary use case:
  - Pasting Markdown-formatted text
  - Light edits
- Editor model:
  - Plain text editor
  - Toggle preview; format selection (Markdown, Text, JSON, YAML) in More menu
- No WYSIWYG editor required

---

## 9b. Daily Journal

- Logseq-inspired daily journal entries stored in `/data/journal/`
- Each entry has `subject: "Journal"` and title format `YYYY-MM-DD DayName`
- Created via "Journal" button or **Ctrl+J** (uses browser local date)
- Idempotent: clicking again on the same day reopens the existing entry
- Sidebar shows a collapsible year/month/day tree pinned above regular notes
  - Current year and month auto-expanded; older periods collapsed
  - Collapse state persisted in localStorage
- Clicking a day opens the note in an editable tab
- Clicking a month or year label opens an aggregated read-only preview tab
- All existing features work: encryption, PDF export, rename, delete, restore, search
- Restored journal notes return to the journal directory (not notes)
- Export ZIP includes `journal/` folder
- WebDAV sync includes journal directory

---

## 10. Note Lifecycle

### 10.1 Deletion

- Soft delete only
- Deleted notes are moved to `/trash/`
- Metadata updated (`deleted: true`)

### 10.2 Restore

- Notes can be restored from trash
- No automatic purge

### 10.3 Version Safety

- Autosave revision counter (`rev`)
- File-system level backups recommended
- Full history UI is out of scope

---

## 11. Export & Backup

- Download individual notes
- Export all notes as ZIP
- Export selected notes as ZIP
- Upload/import `.md` and `.txt` files
- PDF export with Markdown rendering, metadata headers, and TLP footer

---

## 12. PDF Export

- Rendered via reportlab
- Markdown content converted to PDF flowables (headings, paragraphs, code blocks, lists, tables)
- Falls back to plain-text wrapping when Markdown library unavailable
- Per-note settings: author, company, version, date, TLP classification
- Header: title + company/author/version
- Footer: page numbers + TLP label with color coding
- TLP levels: CLEAR, GREEN, AMBER, AMBER+STRICT, RED

---

## 13. WebDAV Sync

- Rclone sidecar container syncs notes to any WebDAV server (e.g. Nextcloud)
- Modes:
  - Push (local → WebDAV)
  - Pull (WebDAV → local)
  - Bisync (two-way)
- Configurable sync interval (minimum 10 seconds)
- Safety: "No deletes" option prevents remote deletion propagation
- UI controls: test connection, manual sync trigger, pause/resume
- Settings stored in `notes/sync/settings.json`
- Status tracked in `notes/sync/status.json`

---

## 14. Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+N | New note |
| Ctrl+J | Open today's journal |
| Ctrl+K | Search / find in note |
| Ctrl+H | Search & Replace panel |
| Ctrl+Shift+R | Rename modal |
| Ctrl+X | Close current tab |
| Esc | Clear search / close dialogs |

---

## 15. UI Style Guide

### 15.1 Design Principles
- Clear, distraction-free layout
- No decorative icons or symbols
- Text-based controls where possible
- Full browser width usage
- Desktop-first

### 15.2 Theme
- Two themes: Light, Dark
- Nordic-inspired, soft, low-saturation colors
- Minimal palette

### 15.3 CSS Tokens (semantic)
Use CSS variables:
- `--bg`, `--surface`, `--surface-2`
- `--text`, `--muted`
- `--border`, `--accent`, `--danger`

---

## 16. Security Model

- No authentication
- No CSRF protection
- No attachments
- Strict path restrictions
- Backend operates only inside configured root directory

---

## 17. Architecture & Tech Stack

### Backend
- Python 3.12
- Flask
- reportlab (PDF generation)
- pyyaml, markdown
- File-based storage
- JSON API

### Frontend
- Plain HTML / CSS / JS (no frameworks)
- Polling-based updates

### Deployment
- Docker + docker-compose
- Rclone sidecar container for WebDAV sync
- Symlink-based releases with rollback support

---

## 18. API Overview

### Notes
- `GET /api/notes` – list notes (with search, sort, filter)
- `POST /api/notes` – create note
- `GET /api/notes/{id}` – get note content + metadata
- `PUT /api/notes/{id}/content` – save content (autosave)
- `PUT /api/notes/{id}/meta` – update metadata (title, subject, pinned)
- `DELETE /api/notes/{id}` – soft delete
- `POST /api/notes/{id}/restore` – restore from trash
- `GET /api/notes/{id}/download` – download single note

### PDF
- `GET /api/notes/{id}/pdf-settings` – get PDF metadata
- `PUT /api/notes/{id}/pdf-settings` – update PDF metadata

### Journal
- `POST /api/journal/today` – create or open today's journal entry
- `GET /api/journal/aggregate?year=&month=` – aggregated content for a period

### Import & Export
- `POST /api/notes/import` – upload files as notes
- `GET /api/export/all` – export all as ZIP
- `POST /api/export_selected` – export selected as ZIP

### Sync
- `GET /api/sync/settings` – get sync config
- `POST /api/sync/settings` – save sync config
- `GET /api/sync/status` – get sync status
- `POST /api/sync/run` – trigger manual sync
- `POST /api/sync/pause` – pause/resume sync
- `POST /api/sync/test` – test WebDAV connection

### Utility
- `GET /health` – health check
- `POST /api/index/rebuild` – rebuild metadata index cache
- `POST /api/preview/yaml` – validate YAML

---

## 19. Explicit Non-Goals

- Multi-user support
- Authentication / RBAC
- Attachments
- Mobile-first UI
- Real-time collaboration
- External integrations

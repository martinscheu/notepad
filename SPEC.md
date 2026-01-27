# Sticky Notes Web App – Specification (v0.2)

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
│   ├── trash/
│   └── exports/
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
  "filename": "2026-01-06_21-14-33_ab12cd34.md",
  "subject": "Research",
  "pinned": false,
  "deleted": false
}
```

Notes:
- `rev` is an integer revision counter, incremented on every save
- Unknown fields must be ignored (forward-compatible)
- `subject` is an optional grouping label shown in the notes list

---

## 6. Autosave & Concurrency Model

### 6.1 Autosave Trigger

- Autosave on keystroke
- Debounce delay: 500 ms – 1 s
- No explicit “Save” button

### 6.2 Visual Feedback

- Subtle “Saved” indicator
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

### 7.1 Views

- Board view
  - Notes displayed as cards
  - Pinned notes appear first
- List view
  - Compact, sortable
  - Optimised for search and scanning

User can switch freely between views.

### 7.2 Sorting & Filtering

Sorting:
- Last updated
- Created
- Filename

Filtering:
- Pinned / unpinned
- Full-text search

---

## 8. Search

- Full-text search across:
  - Filename
  - Note content
- Case-insensitive
- Instant filtering
- Server-side file scan (V1)
- No advanced query syntax

---

## 9. Markdown Handling

- Notes may contain Markdown
- Primary use case:
  - Pasting Markdown-formatted text
  - Light edits
- Editor model:
  - Plain text editor
  - Optional preview toggle
- No WYSIWYG editor required

---

## 10. Note Lifecycle

### 10.1 Deletion

- Soft delete only
- Deleted notes are moved to `/trash/`
- Metadata updated (`deleted: true`)

### 10.2 Restore

- Notes can be restored from trash
- No automatic purge in V1

### 10.3 Version Safety

- Autosave revision counter (`rev`)
- File-system level backups recommended
- Full history UI is out of scope for V1

---

## 11. Export & Backup

- Backend supports:
  - Export all notes as a ZIP archive
- GUI:
  - “Download all notes” button
- Restore:
  - Handled via scripts later (out of scope for GUI v1)

---

## 12. Keyboard-First Workflow

Minimal keyboard shortcuts:
- Ctrl+N – create new note
- Ctrl+K – focus search
- Ctrl+P – pin / unpin current note
- Esc – exit search / close dialogs

Shortcuts are discoverable via help text (no iconography).

---

## 13. UI Style Guide

### 13.1 Design Principles
- Clear, distraction-free layout
- No decorative icons or symbols
- Text-based controls where possible
- Full browser width usage
- Desktop-first

### 13.2 Theme
- Two themes:
  - Light
  - Dark
- Nordic-inspired, soft, low-saturation colors
- Minimal palette

### 13.3 CSS Tokens (semantic)
Use CSS variables:
- `--bg`
- `--surface`
- `--surface-2`
- `--text`
- `--muted`
- `--border`
- `--accent`
- `--danger`

### 13.4 Components
- Notes:
  - Card-like appearance
  - Subtle border
  - Soft background
  - Modest radius
- Pinned notes:
  - Appear first
  - Slightly different surface tone (no icons)
- Buttons:
  - Minimal styling
  - Text labels
- Editor:
  - Plain textarea
  - Optional preview

---

## 14. Security Model

- No authentication
- No CSRF protection
- No attachments
- Strict path restrictions
- Backend operates only inside configured root directory

---

## 15. Architecture & Tech Stack

### Backend
- Python
- Flask
- File-based storage
- JSON API

### Frontend
- Plain HTML
- CSS (custom, no framework required)
- Vanilla JavaScript
- Polling-based updates

---

## 16. API Overview (V1)

- `GET /api/notes`
- `POST /api/notes`
- `GET /api/notes/{id}`
- `PUT /api/notes/{id}/content`
- `PUT /api/notes/{id}/meta`
- `DELETE /api/notes/{id}`
- `POST /api/notes/{id}/restore`
- `GET /api/export/all`

---

## 17. Explicit Non-Goals

- Multi-user support
- Authentication / RBAC
- Attachments
- Mobile-first UI
- Real-time collaboration
- External integrations

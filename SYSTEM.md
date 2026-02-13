# Stickynotes – System Description

## Purpose
A lightweight, self-hosted web app for personal notes, CLI snippets, and Markdown text.
Designed for homelab use, LAN/VPN only, single user, no auth.

## Design Principles
- Autosave-first (no save button)
- Keyboard-first workflow
- File-based storage (no DB)
- Safe updates (code vs data separation)
- Simple, boring, maintainable

## Runtime Model (Host)
Base directory:
`/opt/stickynotes`

Structure:
```
/opt/stickynotes/
├── releases/          # versioned app code
├── current -> releases/<version>
├── notes/             # persistent data
│   ├── notes/
│   ├── journal/       # daily journal entries
│   ├── trash/
│   ├── exports/
│   └── sync/          # WebDAV sync settings & status
└── config/
    ├── config.json
    └── compose.env
```

- `notes/` is NEVER touched by deploys
- `config/` is created once and preserved
- rollbacks are done via symlink switch

## Deployment Workflow
1. Run `scripts/bootstrap.sh` once on host
2. Upload release ZIP or deploy from a working tree directory
3. Run `scripts/deploy.sh <zip>` or `scripts/deploy.sh <dir> <version>`
4. Script:
   - unzips or copies into releases/<version>
   - updates `current` symlink
   - docker compose build --no-cache
   - docker compose up -d

## Container Model
- Flask app inside container
- Binds to container port 8060
- Host binding controlled via env:
  - BIND_ADDR (LAN, VPN, or 0.0.0.0)
  - HOST_PORT (default 8060)

Volumes:
- /opt/stickynotes/notes → /data
- /opt/stickynotes/config → /config (read-only)

## Autosave & Concurrency
- Keystroke autosave (500ms–1s debounce)
- Revision counter (`rev`)
- Polling every ~5s for idle tabs
- Last writer wins

## UI
- Tabbed editor with sidebar notes list
- Notes grouped by subject with collapsible groups
- Subject autocomplete from existing subjects
- Pinned notes appear first
- Full-text search (filename + content)
- Search & Replace panel with multi-match highlighting
- Table of Contents panel with selectable heading depth
- Markdown / Text / JSON / YAML preview
- Nordic, low-distraction theme
- Dark / light mode
- No icons, text-based controls
- Daily journal with collapsible year/month/day tree, aggregate views (Ctrl+J)
- Deep links via `/?id=<note_id>`

## PDF Export
- Markdown-rendered PDF via reportlab
- Per-note metadata: author, company, version, date
- Header with title + metadata, footer with page numbers
- TLP classification footer (CLEAR / GREEN / AMBER / AMBER+STRICT / RED) with color coding
- TLP badge shown in editor header for active note

## WebDAV Sync
- Rclone sidecar container for WebDAV sync (e.g. Nextcloud)
- Modes: Push (local → remote), Pull (remote → local), Bisync (two-way)
- Configurable interval (minimum 10s)
- Safety option: "No deletes" prevents remote deletion propagation
- Test connection from UI
- Manual trigger and pause/resume controls
- Settings stored in `notes/sync/settings.json`
- Status tracked in `notes/sync/status.json`

## Import & Export
- Upload/import `.md` and `.txt` files via UI
- Download individual notes
- Export all notes as ZIP
- Export selected notes as ZIP

## Out of Scope
- Multi-user
- Auth
- Attachments
- Real-time collaboration

## Current Version
- 1.2.10

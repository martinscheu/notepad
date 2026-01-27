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
│   ├── trash/
│   └── exports/
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
- Board view + list view
- Pinned / unpinned
- Full-text search
- Nordic, low-distraction theme
- Dark / light mode
- No icons, text-based controls

## Out of Scope
- Multi-user
- Auth
- Attachments
- Real-time collaboration

## Current State
- Repo scaffolding complete
- Bootstrap & deploy scripts complete
- Docker compose + container wiring complete
- Flask backend implemented (file storage + API)
- Frontend implemented (HTML/CSS/JS)
- Atomic writes for content/metadata
- Metadata index cache with manual rebuild endpoint (`POST /api/index/rebuild`)
- Deep links supported via `/?id=<note_id>`
- Search/replace panel with multi-match highlighting
- TOC panel with selectable depth and preview anchors
- Markdown tables supported in preview
- Manual preview format selection (Markdown / JSON / YAML)
- JSON pretty-print and validation in preview
- YAML validation + pretty-print in preview
- Upload/import of `.md` and `.txt` files via UI (creates notes from files)
- Active note highlighted in both tabs and notes list

## Next Steps
- Optional: add SQLite FTS index for search if notes become large
- Optional: add basic revision history

## Current Version
- 1.1.26

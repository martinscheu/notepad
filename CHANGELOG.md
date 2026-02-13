# Changelog

## 1.2.10

- **Search & Replace: inverted match highlighting** — all matches now show inverted text (white on dark in light mode, dark on white in dark mode) via a dual-overlay system. The focused match has a stronger opaque background with outline; other matches use a slightly transparent version of the same style. Highlights scroll in sync with the editor using transform-based positioning and scrollbar width compensation.
- **Search & Replace: Find previous** — added "Find prev" button to navigate matches backwards.
- **Search & Replace: live current match tracking** — current match updates in real time as you click or arrow through the editor.
- **Undo / Redo buttons** — added Undo and Redo buttons to the topbar for quick access in edit mode (uses the browser's native undo stack).

## 1.2.3

- **German umlaut transliteration** — filenames, PDF downloads, and markdown downloads now transliterate German umlauts (ä→ae, ö→oe, ü→ue, ß→ss) and strip other diacritics via NFKD normalization, both server-side and client-side.

## 1.2.0

- **Daily Journal** — Logseq-inspired daily journal feature. Journal notes live in a dedicated `/data/journal/` directory and appear in the sidebar as a collapsible year/month/day tree pinned at the top.
  - Click "Journal" button or press **Ctrl+J** to create/open today's journal entry
  - Journal entries titled with date and day name (e.g. "2026-02-13 Thursday")
  - Sidebar tree auto-expands current year/month, collapses older periods
  - Click a day to open that entry; click a month or year label to open an aggregated read-only preview
  - Aggregate tabs concatenate all entries for the period with date headers and dividers
  - All existing features work on journal notes: encryption, PDF export, rename, delete, restore
  - Restored journal notes return to the journal directory (not notes)
  - Export includes `journal/` folder in ZIP
  - WebDAV sync includes journal directory

## 1.1.63

- **Copy button on code blocks** — preview mode now shows a "Copy" button in the top-right corner of every `<pre>` block. Appears on hover, works for Markdown, JSON, YAML, and text previews. Uses `navigator.clipboard` with a `document.execCommand('copy')` fallback for plain HTTP contexts.
- **Clickable TLP badge** — the TLP badge next to the filename in the editor bar is now clickable. Each click cycles through CLEAR → GREEN → AMBER → AMBER+STRICT → RED and saves immediately via the `/pdf-settings` API. If TLP:RED triggers auto-encryption on the backend, the encrypted badge updates in place.
- **Fix: metadata modal overwriting note title** — opening the metadata modal (without rename) left the hidden rename-input field with a stale value from a previous modal open. On save, that stale title was sent to the API, renaming the current note to a different note's title. Fixed by always populating the rename-input with the current note's title regardless of modal mode.
- **Cursor and scroll persistence** — cursor position and scroll offset are saved per note in `localStorage` (key: `sn_cursor`). Restored when switching tabs or reopening a note after page reload. Saved on tab switch, content save, editor scroll (debounced 500ms), and `beforeunload`. New notes default to cursor at top. Uses `requestAnimationFrame` for reliable scroll restoration after content load.

## 1.1.56

- Split rename and metadata into separate modal modes (rename-only vs metadata-only)
- Fix settings modal bindings after topbar reorganization
- Topbar cleanup and consistent button styling

## 1.1.55

- Reorganize topbar into logical action groups (file, view, edit)
- Add "More" dropdown menu for less common actions
- Codespaces devcontainer support

## Earlier versions

- **Subjects and grouping** — notes grouped by subject in sidebar with collapsible groups
- **PDF export** — Markdown-rendered PDF with configurable header/footer, per-note metadata (author, company, date), TLP classification badge in footer
- **TLP:RED auto-encryption** — backend automatically encrypts note content when TLP is set to RED and encryption is configured (Fernet, PBKDF2 480k iterations)
- **Markdown preview** — format selection (Markdown, Text, JSON, YAML) with YAML server-side validation
- **Citation normalization** — smart quotes and dashes normalized on paste and import
- **Search & Replace** — in-note find/replace with match highlighting overlay
- **Table of Contents** — TOC panel with selectable heading depth
- **WebDAV sync** — push/pull/two-way sync via rclone sidecar
- **Per-note encryption** — Fernet AES-128-CBC + HMAC, key derived from passphrase via PBKDF2
- **Import/Export** — upload .md/.txt files, download individual notes or ZIP of all
- **Deep links** — `/?id=<note_id>` for direct note access
- **Note upload** — drag-and-drop or file picker for .md/.txt import
- **Markdown tables** — GFM-style table rendering in preview

## Technical notes

- `navigator.clipboard.writeText` is unavailable on plain HTTP — always include the `execCommand` fallback
- Modal fields retain their DOM values across opens; always repopulate on open, not just conditionally
- Setting `textarea.scrollTop` immediately after changing `.value` is unreliable — use `requestAnimationFrame` for deferred restoration
- localStorage key `sn_cursor` stores `{noteId: {c: cursorPos, s: scrollTop}}` — cleared per-note, not globally
- TLP cycle saves via `/api/notes/<id>/pdf-settings` which also triggers backend auto-encryption for RED

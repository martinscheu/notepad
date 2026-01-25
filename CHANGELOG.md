# Changelog

All notable changes to Stickynotes will be documented here.

## 1.1.13
- Reordered top-bar actions into grouped clusters with clearer spacing.
- Added right-side Search & Replace panel (non-persistent) with match count.
- Added multi-match highlighting overlay in the editor; highlight disables for very large notes.
- Added deep-link support via `/?id=<note_id>` and a "Copy link" button.
- Added rename modal (no browser prompt) with keyboard support.
- Fixed Replace button wiring and added "Find next".
- Updated tab sort button labels to include "Tab sort:".
- Backend: atomic writes for content/metadata; metadata index cache with manual rebuild endpoint.
- Backend: fixed `export_selected`; rename now updates filename + title per spec.

## 1.1.6
- Fixed replace modal event binding.

## 1.1.4
- UI: clarified tab sort toggle text.

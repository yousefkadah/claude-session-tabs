# Changelog

All notable changes to **Claude Code Tabs** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.2] — 2026-07-02

### Changed
- Renamed the extension to **Claude Code Tabs** (display name).

## [0.1.1] — 2026-07-02

### Fixed
- View title actions (Search / New Group / Refresh) and the right-click context
  menu now appear on the Session Tabs view (menus were gated on a stale view id).

### Changed
- Professional README with screenshots, a hover-preview image, and badges.
- Slimmer published package (dev docs, CI, tests, and screenshots excluded).

## [0.1.0] — 2026-07-02

Initial release.

### Added
- **Sessions view** (Activity Bar): every Claude Code conversation in the
  workspace, with colored status dots (active / working / open / closed).
- **Rich hover preview**: last user + Claude message, git branch, context-token
  count, message count, and relative activity time.
- **Groups**: create named, colored groups; drag sessions between them;
  collapse/expand; state persists per workspace.
- **Horizontal strip** (bottom panel webview): a browser-like tab strip that
  shares the same data, with hover previews, drag-to-group, and close/pin.
- **Search** command: fuzzy-find sessions by title or last prompt.
- **Pinning** and reopening of closed sessions.
- In-product **walkthrough** (Getting Started).

### Notes
- Chrome-style features live in a sidebar/panel because the VS Code API cannot
  customize the native editor tab bar (no tab-hover API, tabs are read-only
  except `close()`). See `DESIGN.md`.

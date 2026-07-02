# Changelog

All notable changes to **Claude Code Tabs** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.11] — 2026-07-03

### Fixed
- A new session started from a group now opens **beside your existing Claude tabs**
  (in their editor column) instead of over the code editor.

## [0.1.10] — 2026-07-03

### Fixed
- **Start New Session in a group** now works reliably. Instead of guessing the new
  session by id/time (which raced with transcript creation), it latches onto the
  new tab's stable object, shows it in the group immediately, and persists the
  assignment once the session gets a real id.

## [0.1.9] — 2026-07-03

### Fixed
- **Start New Session in a group** now reliably adds the new session to the group.
  The previous detection required the session to be tab-matched at the exact moment
  it appeared, so it often landed in Ungrouped instead. Detection no longer requires
  the match and uses a time window.

## [0.1.8] — 2026-07-03

### Added
- **Flag for attention** — manually flag any session (bell inline action, right-click,
  or the strip's 🔔 button). Flagged sessions get a bell icon, sort to the top, and
  show a count badge on the view. A reliable, user-controlled replacement for the
  removed auto "waiting" indicator (Claude's real needs-action state isn't exposed).

## [0.1.7] — 2026-07-03

### Added
- **Start a new session in a group** — each group has a `+` action that opens a new
  Claude conversation; it joins the group once it has its first message.

### Fixed
- Clicking a session now reveals it as the **active editor tab** (opens in the active
  column instead of being pushed to the panel).

### Removed
- The "waiting for you" indicator. Claude's needs-action state (the blue dot on its
  tab) is a private tab icon that the VS Code API does not expose to other extensions,
  and the "who spoke last" heuristic was too noisy (false positives), so the alert
  was removed rather than shipped inaccurate.

## [0.1.6] — 2026-07-02

### Changed
- Document the **“waiting for you”** indicator in the README (yellow highlight +
  bell + Activity Bar count badge for sessions where Claude replied last).

## [0.1.5] — 2026-07-02

### Added
- **"Waiting for you" indicator** — sessions where Claude sent the last message
  (your turn) now show a yellow bell icon, sort to the top, and add a count
  **badge on the Activity Bar icon**. In the horizontal strip they get a
  highlighted yellow background. Makes it easy to spot conversations that need
  your reply. (Claude's internal permission state isn't exposed to extensions,
  so this is inferred from who sent the last message.)

## [0.1.4] — 2026-07-02

### Added
- Restored the standalone **Claude Code Tabs** view in the Activity Bar, alongside
  the mirror inside the Claude Code sidebar. Both share one data source.

### Fixed
- The right-click menu (rename / recolor / delete group, pin, move to group) and
  the title actions (Search / New Group / Refresh) now work in **both** tree views.

## [0.1.3] — 2026-07-02

### Fixed
- Complete the rename — the bottom-panel title and command category now read
  **Claude Code Tabs** too (0.1.2 changed only the display name).

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

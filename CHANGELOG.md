# Changelog

All notable changes to **Claude Code Tabs** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-07-07

### Added
- **Attention sound + notification.** With Real-time Attention enabled, a session that
  starts waiting on you now also **plays a sound** and **shows a notification** — a
  native OS banner when VS Code is in the background, or an in-app toast with a
  **Reveal** button when it's focused. Fires once on the transition into "needs you"
  (not on every refresh) and only for the window that owns the session. New settings:
  `attentionSound`, `attentionNotification`, `attentionSoundName` (macOS sound). All
  best-effort and local — nothing leaves your machine.

## [0.2.0] — 2026-07-07

### Added
- **Multi-branch / git-worktree support** — run and organize several Claude sessions
  across branches of the same repo.
  - **Group by Branch** — a toggle (git-branch icon) on the Sessions view buckets your
    sessions by the branch each ran on, most-recent branch first. Works with the
    show/hide-closed control per branch.
  - **Branches view** — a new view listing this repo's git worktrees (via
    `git worktree list`), each expandable to its sessions with the same hover previews.
    One place to see every branch you're working in parallel.
  - **Open across worktrees** — clicking a session that lives in another worktree offers
    to open that worktree in a new window and resume the exact session there, via a
    single-use local hand-off file.
  - **New Branch Session…** — one action creates a git worktree for a branch (new or
    existing) and starts a fresh Claude session in it.

## [0.1.18] — 2026-07-04

### Added
- **Real-time "needs you" bell via Claude Code hooks (opt-in).** Turn it on from the
  view's **⋯** menu → **Enable Real-time Attention** (it shows exactly what it will add
  and asks first). It registers three hooks in `~/.claude/settings.json` that light the
  bell the **instant** Claude asks a question, presents a plan, or needs permission —
  no waiting on the transcript, which Claude Code doesn't write in real time. The bell
  clears the moment you reply. Fully reversible via **Disable Real-time Attention**; the
  hooks only touch a local marker folder the extension watches — nothing is sent anywhere.

### Changed
- The `needs-action` status now combines the hook signal (instant) with the existing
  transcript detection (authoritative) and self-heals: a stale marker is ignored once the
  transcript advances past it, so the bell never sticks.

## [0.1.17] — 2026-07-04

### Added
- **Active-only groups with a per-group reveal toggle.** Every group — including
  **Ungrouped** — now shows only its **active/open** (and pinned) sessions by default.
  Each group row has an **👁 eye** action (and the strip an eye button) to reveal its
  closed sessions, plus a `N hidden` count. Click again to collapse back to active-only.
  The choice persists per group, per workspace.

## [0.1.16] — 2026-07-03

### Removed
- The **"working" 🔄 indicator**. Claude Code doesn't write its transcript in real time
  (measured multi-minute gaps mid-turn), so an mtime-based "generating now" signal was
  unreliable. Status is now **active / needs-action / open / closed** — all accurate.
  ("Needs-action" is content-based, so it's unaffected.)

## [0.1.15] — 2026-07-03

### Changed
- Only **active** subagents are shown under a session (recently running); finished ones
  are hidden, and a session is expandable only when it has a live subagent.

### Added
- **Click a subagent** to open a read-only panel with its task and what it did (its text
  output and the tools it called).

## [0.1.14] — 2026-07-03

### Added
- **Subagents as children** — expand a session to see the subagents Claude spawned in it
  (read from the session's `subagents/` sidecar dir). Each shows its agent type + task
  and a spinner while active. Cached by the sidecar dir's mtime.

## [0.1.13] — 2026-07-03

### Added
- **Live "working" indicator** — a session whose transcript changed in the last ~15s
  shows a reload icon (Claude is generating). Reliable, based on file activity.
- **Automatic "waiting for you"** — a session whose last turn ended on an unanswered
  `AskUserQuestion` / `ExitPlanMode` (and isn't writing) is flagged with a bell, sorted
  to the top, and drives a count badge on the view icon.

### Removed
- The manual **flag-for-attention** (bell on every row) — replaced by the automatic
  detection above.

### Fixed
- Two brand-new "Claude Code" tabs in the same editor group no longer collide on a shared
  synthetic id (which duplicated tree nodes and shared pin/group state).
- Dropped dead `lastRole` parsing left over from the earlier waiting feature.

## [0.1.12] — 2026-07-03

### Fixed
- Clicking a **closed** session now opens it beside your existing Claude tabs (their
  editor column) instead of over the code editor. Already-open sessions still reveal
  in place.

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

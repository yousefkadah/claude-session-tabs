# Design & VS Code API analysis

This documents *why* the extension is built the way it is — mainly, why the Chrome-style
features live in a **sidebar** and not on the native editor tab bar. Findings verified July 2026
against `vscode.d.ts` (microsoft/vscode `main`), the `src/vscode-dts/` proposed-API directory,
workbench source, and the VS Code issue tracker.

## What the VS Code API does NOT allow (the constraints)

| Desired (Chrome-like) | API reality |
| --- | --- |
| Custom hover popup on an editor tab | **No API at all**, stable or proposed. The native tab hover is hardcoded in `editorTabsControl.ts` to `editor.getTitle(LONG)`. No contribution point for your tabs or another extension's. Requests: microsoft/vscode #41909, #32088 (both open, years old). |
| Colored / labeled tab **groups** in one tab bar | Don't exist. VS Code "tab groups" == split editor panes (`TabGroup` keyed by `ViewColumn`). Chrome-style groups: #100335 (open, Backlog); community PR #315366 under review but **not merged**. |
| Recolor / rename / reorder / pin a specific tab via API | The tab API is **read-only except `close()`**. `TabGroups` exposes `all`, `activeTabGroup`, `onDidChangeTabs`, `onDidChangeTabGroups`, and `close(tab|tabs|group|groups)`. Nothing else — no move, pin, activate/reveal, or label/tooltip mutation. Reveal request: #188572 (open). |
| Badge / color a specific webview tab | `FileDecorationProvider` is URI-keyed. A webview tab's internal URI (`webview-panel:webview-{viewType}-{randomUUID}`) carries a random UUID that is **never exposed** through `TabInputWebview` (which surfaces only `viewType`). So you could at best decorate *all* Claude tabs identically — useless for per-tab state. |
| Read a live tab's `sessionId` | Not exposed. `TabInputWebview` gives only `viewType`. The extension's `sessionId → panel` map is in-memory. (The exact id is recoverable from the workspace `state.vscdb` `memento/workbench.parts.editor`, but that's flushed only periodically, so it lags live state — not used here.) |

The extensions that *do* paint the tab bar (Tabscolor, APC/Custom CSS) patch VS Code's installed
CSS/JS on disk. That triggers the "installation appears corrupt" banner, breaks on every update,
and is explicitly unsupported. We don't build on it.

## What the API DOES allow (what we use)

- **`window.tabGroups`** (stable since 1.67): enumerate tabs, read `label` / `isActive` / `isDirty`
  / `isPinned`, identify Claude tabs via `tab.input instanceof TabInputWebview &&
  input.viewType.includes('claudeVSCodePanel')`, observe `onDidChangeTabs` /
  `onDidChangeTabGroups`, and `close()` a tab.
- **`TreeView`**: `TreeItem.tooltip` accepts a **`MarkdownString`** (rich hover — the key win),
  per-item `ThemeIcon` + `ThemeColor` (state dots + group colors), `description`, collapsible
  group nodes, and `TreeDragAndDropController` (drag sessions between groups).
- **`workspaceState`** (`Memento`): persist groups, assignments, pins per workspace.
- **`createFileSystemWatcher`** with an absolute `RelativePattern`: watch
  `~/.claude/projects/<slug>/*.jsonl` (outside the workspace) to refresh as sessions progress.
- **Commands**: reveal a session with `claude-vscode.editor.open <sessionId>` (fallback URI
  `vscode://anthropic.claude-code/open?session=<id>`). `QuickPick` for search/pickers.

## Claude Code specifics we depend on (v2.1.x)

- **Tab identity**: webview `viewType` `claudeVSCodePanel` (VS Code surfaces it as
  `mainThreadWebview-claudeVSCodePanel`; `.includes()` matches both).
- **Tab label** = session title truncated to `len>25 ? slice(0,24)+'…' : title`, else `Claude Code`.
  We reproduce this in `claudeTruncateLabel()` to match tabs → sessions.
- **Transcripts**: `~/.claude/projects/<slug>/<uuid>.jsonl`. Slug = cwd with `/ \ . whitespace :`
  → `-`. Title precedence: `custom-title` > `ai-title` > `last-prompt` > `summary` > first user
  prompt. Per-record fields: `gitBranch`, `cwd`, `timestamp`; assistant `message.usage.*` for
  tokens; visible text in `message.content` (string, or `type:"text"` blocks). Subagent
  transcripts carry `"isSidechain":true` and are excluded.
- The extension exports **no public API** (`getExtension(...).exports` is undefined), so we read
  transcripts directly rather than calling into it.

## Consequences / trade-offs baked into the code

- Tab↔session matching is by truncated label (mtime tiebreak); the rare identical-title collision
  self-corrects on the next update.
- "Open" reveals via command; there's no API to focus an arbitrary already-open tab otherwise.
- Very large transcripts (>3 MB) are parsed head+tail only; such rows show `~`/`+` on token and
  message counts to signal the approximation.

## Possible future upgrades

- If native Chrome-style groups (#315366) or a tab-hover API ever ship, revisit — the data layer
  (`sessionStore`) is independent of the presentation and would carry over unchanged.
- A webview-based horizontal "tab strip" rendering is a drop-in alternative to the TreeView using
  the same `SessionStore`; only worth it if the horizontal look specifically matters.

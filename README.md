<div align="center">

<img src="https://raw.githubusercontent.com/yousefkadah/claude-session-tabs/main/resources/icon.png" width="96" alt="Claude Code Tabs" />

# Claude Code Tabs

**Chrome-style tab management for the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) VS Code extension** — named + colored **groups**, a searchable session list, **pinning**, and a **rich hover preview** for every conversation.

[![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/yousefkadah.claude-session-tabs?color=1f8ceb&label=Marketplace&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=yousefkadah.claude-session-tabs)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/yousefkadah.claude-session-tabs?color=1f8ceb)](https://marketplace.visualstudio.com/items?itemName=yousefkadah.claude-session-tabs)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/yousefkadah.claude-session-tabs?color=1f8ceb)](https://marketplace.visualstudio.com/items?itemName=yousefkadah.claude-session-tabs)
[![CI](https://github.com/yousefkadah/claude-session-tabs/actions/workflows/ci.yml/badge.svg)](https://github.com/yousefkadah/claude-session-tabs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/yousefkadah/claude-session-tabs/main/media/screenshots/sidebar.png" width="460" alt="Grouped Claude sessions with status dots" />

</div>

---

> **Why a sidebar, not the real tab bar?**
> VS Code's extension API deliberately can't customize editor‑tab hovers, can't color or group individual webview tabs, and exposes tabs as read‑only (except close). The only extensions that paint the tab bar do it by patching VS Code's files on disk — which breaks on every update. So this extension mirrors your Claude conversations into a proper view where all of these features are *supported* APIs. Full analysis in [DESIGN.md](DESIGN.md).

## ✨ Features

- **🗂️ Groups** — create named, colored groups and drag sessions between them, or **start a new session straight into a group** with the group's `+` button. They collapse and persist per workspace, just like Chrome tab groups.
- **🔄 Live progress & attention** — sessions Claude is **actively working** show a reload icon; sessions where Claude **asked you a question or plan and is waiting** float to the top with a **bell + count badge** on the icon. All inferred from the transcript (Claude's own state isn't exposed to extensions), so working is exact and "waiting" is a strong heuristic.
- **👀 Rich hover preview** — the last **You / Claude** messages, git branch, context‑token count, message count, and last‑active time — without opening the session.
- **🟢 Live status** — at a glance: **active** (green), **working** (🔄 blue), **waiting for you** (🔔 yellow), **open** (blue), **closed** (outline).
- **📌 Pinning** — keep the sessions you return to at the top.
- **🔎 Search** — fuzzy‑find any conversation in the workspace by title or last prompt, then jump to it.
- **↔️ Two surfaces, one data source** — a tree inside the Claude Code sidebar **and** a horizontal Chrome‑style strip in the bottom panel, always in sync.
- **🔒 Local only** — everything is read from your local `~/.claude` transcripts; nothing is sent anywhere.

## 📸 Screenshots

### Grouped sessions in the Claude Code sidebar
Colored groups, live status dots, and per‑workspace organization — nested right inside Claude Code's own sidebar.

<img src="https://raw.githubusercontent.com/yousefkadah/claude-session-tabs/main/media/screenshots/sidebar.png" width="520" alt="Session Tabs tree with a colored group" />

### Rich hover preview
Hover any session for an at‑a‑glance card of the conversation.

<img src="https://raw.githubusercontent.com/yousefkadah/claude-session-tabs/main/media/screenshots/hover.png" width="560" alt="Hover preview card" />

### Horizontal tab strip (bottom panel)
Prefer a browser‑like strip? The **Claude Code Tabs** panel gives grouped tab chips with the same previews and drag‑to‑group.

<img src="https://raw.githubusercontent.com/yousefkadah/claude-session-tabs/main/media/screenshots/strip.png" width="620" alt="Horizontal session strip" />

## 🚀 Install

1. Open **Extensions** in VS Code (`⇧⌘X` / `Ctrl+Shift+X`) and search **“Claude Code Tabs”**, or run:
   ```
   ext install yousefkadah.claude-session-tabs
   ```
2. Make sure the **[Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)** extension is installed and you've opened at least one conversation.
3. Open the **Claude Code Tabs** icon in the Activity Bar (or find **Session Tabs** inside the Claude Code sidebar). For the horizontal strip, open the bottom panel (`⌘J` / `Ctrl+J`) → **Claude Code Tabs**.

**Requirements:** VS Code `^1.84.0` (or a compatible fork) and the Anthropic **Claude Code** extension.

## 🧭 Where it lives

- **Claude Code Tabs** (Activity Bar) — the dedicated **Sessions** tree, always available.
- **Session Tabs** (Claude Code sidebar) — the same tree, mirrored inside Claude Code's own sidebar while it's active.
- **Claude Code Tabs** (bottom **panel**, `⌘J` / `Ctrl+J`) — the horizontal Chrome‑style strip.

All three share one data source and stay in sync — use whichever fits your flow.

Right‑click any session or group for actions (pin, move to group, rename/recolor/delete group); use the view's title bar for **Search**, **New Group**, and **Refresh**.

## ⚙️ How it works

- Detects Claude tabs via the Tab API (`TabInputWebview` with the `claudeVSCodePanel` view type).
- Reads session content from `~/.claude/projects/<workspace>/*.jsonl` (subagent transcripts excluded), cached by file mtime so unchanged sessions are never re‑parsed.
- Opens/reveals a session with the Claude Code command `claude-vscode.editor.open`.

## 🔧 Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSessionTabs.maxRecentSessions` | `25` | Max recent (closed) sessions shown under Ungrouped. Open/pinned/grouped always show. |
| `claudeSessionTabs.showClosedSessions` | `true` | Include recently closed sessions, not just open tabs. |
| `claudeSessionTabs.projectDirectory` | `""` | Override the `~/.claude/projects/<slug>` directory. Empty = auto‑detect. |

## ⚠️ Known limitations

- The views live in the sidebar and bottom panel — VS Code's API can't render them on the native editor tab bar.
- A live tab's exact `sessionId` isn't exposed by the Tab API, so sessions are matched to tabs by title (with file mtime as a tiebreaker). Two sessions with identical 24‑char‑truncated titles can rarely be matched in the wrong order until one updates.
- The sidebar view rides Claude Code's container; if a future Claude Code update renames it, the view may need a one‑line update.

## 🛠️ Development

```bash
npm install
npm run watch      # or: npm run compile
npm test           # headless data-layer tests
```
Press **F5** to launch an Extension Development Host. Package a `.vsix` with `npx @vscode/vsce package --no-dependencies`. The code is organized in layers (`model → data → view → wiring`); the full VS Code API analysis is in [DESIGN.md](DESIGN.md).

## 📄 License

[MIT](LICENSE) © yousefkadah

# Multi-Workspace Support — Design

> Status: **design** (no code yet). Decision on 2026‑07‑06: build a **read‑only
> global "All Projects" hub first**; cross‑window launching comes in a later phase.
> This doc is the plan; it mirrors the depth of `jetbrains-plugin-research.md`.

---

## 1. What we're solving

Today Claude Code Tabs shows the sessions of **one** workspace — the folder open
in the current VS Code window. Users who juggle several projects want to:

1. **See** all their Claude Code activity across every project in one place.
2. **Manage / jump to** sessions that live in other workspaces.
3. Have **multiple sessions running against different workspaces** at once.

Goal (3) is partly a property of Claude Code itself (you can already run a session
per window). What the extension can add is **unified visibility** and, later,
**smart routing** to the right window.

---

## 2. The hard constraint: sessions are `cwd`-bound

A Claude Code session is tied to a working directory. This is baked into the
storage layout and into how sessions resume:

- Transcripts live at `~/.claude/projects/<slug>/<uuid>.jsonl`, where
  `slug = cwd.replace(/[^A-Za-z0-9]/g, '-')` (see `SessionStore.doResolve`).
- Every transcript records its real `cwd` in its header (we already read it with
  `readCwd`), so a project directory maps back to exactly one real path.
- Resuming runs `claude-vscode.editor.open(sessionId, …)` **in the current
  window** — it opens the session in *this* window's Claude Code, which is scoped
  to *this* window's folder.

**Consequence:** we cannot make a project‑B session actually execute inside a
project‑A window. A session only runs meaningfully in a window opened on its own
folder. So the feature is necessarily:

> **See everything from one hub + route each session to the window that can run it.**

Not: "run any workspace's sessions inside the current window." That's impossible
with the public API, and we should say so plainly in the UI.

---

## 3. Where we are today (the single-workspace assumptions to unwind)

| Concern | Current behavior | File |
| --- | --- | --- |
| Scope | Uses `workspaceFolders[0]` only | `extension.ts` |
| Project dir | One `SessionStore(cwd)` → one `~/.claude/projects/<slug>` | `data/sessionStore.ts` |
| Session list | `list()` reads only that one dir | `data/sessionStore.ts` |
| Groups / pins | Stored in **`context.workspaceState`** (per window) | `data/groupStore.ts` |
| Attention hooks | Marker files filter by `cwd`; already multi‑project aware | `data/attentionStore.ts` |
| Tree / strip | One flat `entries[]` grouped by user groups | `view/sessionTree.ts` |

Two of these matter most for multi-workspace:

- **`SessionStore` is hard-wired to one cwd.** A hub needs to enumerate *all*
  project dirs.
- **Group/pin state is per-window (`workspaceState`).** State for *other*
  projects wouldn't be visible from this window — see §6.

Good news: the data layer is already cache-by-mtime and the `readCwd` reverse
lookup exists, so enumerating projects is cheap and mostly additive.

---

## 4. The global "All Projects" hub (Phase 1 — read-only)

### 4.1 New data layer: `ProjectRegistry`

A new module that enumerates every project under `~/.claude/projects/` and maps
each to a real workspace path.

```ts
interface ProjectInfo {
  dir: string;        // ~/.claude/projects/<slug>
  cwd: string;        // real path, read from a transcript header (readCwd)
  name: string;       // display name = basename(cwd), disambiguated on collision
  isCurrent: boolean; // matches this window's workspace folder(s)
  sessionCount: number;
  lastActiveMs: number;
}

class ProjectRegistry {
  // Scan ~/.claude/projects/*: for each dir, read ONE transcript's cwd (cheap),
  // stat for lastActive, count *.jsonl. Cache per-dir by mtime.
  async list(): Promise<ProjectInfo[]>;
  // A SessionStore bound to a specific project dir, for lazy per-project loads.
  storeFor(project: ProjectInfo): SessionStore;
}
```

Key point: **we already do the expensive part once** — `doResolve` scans dirs and
reads `cwd` per dir to find the current workspace. `ProjectRegistry` generalizes
that scan to return *all* dirs instead of stopping at the match. Reuse `readCwd`;
read only the first transcript per dir for the `cwd` (a dir belongs to exactly one
cwd, per the existing invariant in `doResolve`).

`SessionStore` gets a tiny refactor: today its constructor takes `(cwd, override)`
and derives the dir. Add a path to construct it **directly from a known project
dir** (skip resolution) so `storeFor()` can reuse all the existing parsing/caching
per project without re-resolving.

### 4.2 View: a separate tree, not a mode toggle

Add a **third view**, `claudeSessionTabsProjects` ("All Projects"), alongside the
existing Sessions tree and strip. Rationale:

- The existing tree's job (groups, pins, drag‑to‑group, new‑session‑in‑group) is
  inherently **current‑workspace**. Overloading it with a cross‑project mode makes
  every command ambiguous ("pin — in which window's state?").
- A dedicated read‑only browser keeps semantics clean and is easy to reason about.

Tree shape:

```
▸ my-app            (current)   3 open · 5
    ● Fix the parser            active
    🔔 Refactor auth            waiting for you
    ○ …
▸ marketing-site                 1 open · 12
    ○ Landing copy
    …
▸ scratch                        0 open · 2
```

- **Top level = projects**, sorted: current workspace first, then by last active.
- **Children = that project's sessions**, reusing the *exact* rendering from
  `sessionTree` (status dot/bell, hover preview, description). Factor the session
  `TreeItem` builder so both trees share it.
- Lazy: only load a project's sessions when its node is expanded (via
  `storeFor(project).list()`), so opening the hub doesn't parse every transcript
  on disk.

### 4.3 Read-only semantics (Phase 1)

- **Hover previews:** yes, for every project (pure reads).
- **Click a session in the *current* project:** open normally (we're scoped to it).
- **Click a session in *another* project:** show an info message —
  *"This session belongs to `marketing-site`. Open that folder to resume it."* —
  with a disabled/absent launch button for now. (Phase 2 wires the launch.)
- **No group/pin/close actions** on other projects (those are per-window state and
  can't act on a foreign window). The current project's node *may* still surface
  them, but simpler for v1: the hub is view‑only; use the main Sessions tree for
  actions in the current workspace.

### 4.4 Refresh & watching

- Watch `~/.claude/projects` shallowly for created/deleted project dirs (rare).
- Keep the existing per‑file watcher for the **current** project (already there).
- For other projects, refresh on hub focus + the 15s tick + manual Refresh. We do
  **not** want N file watchers across every project on disk — document this cap.

---

## 5. Performance & scale

- `~/.claude/projects` can hold **hundreds** of dirs for heavy users.
- Cheap scan: `readdir` + **one** `readCwd` + one `stat` per dir. No full parse.
- Per‑project session parsing is **lazy** (on expand) and cached by mtime.
- Cap/streaming: if there are > N (e.g. 200) projects, show most‑recent first and
  a "showing 200 of 412" footer rather than freezing. `log()`-style honesty about
  truncation (same principle we used for closed‑session caps).

---

## 6. State storage (the subtle part)

| State | Today | For the hub |
| --- | --- | --- |
| Groups (names/colors/assignments) | `workspaceState` (per window) | **Keep per‑workspace.** Cross‑project custom groups add a lot of complexity for little value; the hub groups by *project*, not user groups. |
| Pins | `workspaceState` | Options below. |
| Attention hooks | global files under `~/.claude/hooks/claude-tabs` | already global — nothing to change. |
| Show‑inactive per group | `workspaceState` | per‑workspace; N/A in the hub. |

**Pins decision:** two viable models —

- **(a) Keep pins per‑workspace** (status quo). The hub simply reflects each
  project's own pins. Zero migration. Recommended for v1.
- **(b) Move pins to a machine‑global store** (`context.globalState` or a JSON file
  in `~/.claude/hooks/claude-tabs/`) so a pin is visible from any window and from
  the hub. More coherent long‑term, but needs a one‑time migration from
  `workspaceState` and careful id‑namespacing.

Recommendation: **(a) for Phase 1** (hub is read‑only anyway), revisit (b) only if
we later allow acting on other projects.

---

## 7. Cross-window hand-off (Phase 2 & 3 — documented now, not built)

### Phase 2 — launch the folder

Clicking an other‑project session runs:

```ts
await vscode.commands.executeCommand('vscode.openFolder',
  vscode.Uri.file(project.cwd), { forceNewWindow: true });
```

Reality of VS Code here:

- There is **no API to focus the existing window** already showing folder X.
  `openFolder` without `forceNewWindow` *replaces* the current window's folder
  (destructive); with `forceNewWindow: true` it always spawns a new window (you can
  end up with duplicates). We'll default to `forceNewWindow: true` and accept
  possible duplicate windows, or offer a setting.
- After the new window opens, its own Claude Code Tabs is already scoped to that
  folder — the user finishes by clicking the session there. Acceptable, and it's
  exactly the "Read‑only browse for now" behavior the user picked, plus a launcher.

### Phase 3 — auto-resume the exact session

To open the *specific* session in the new window without the user re‑finding it,
use a **hand-off file** (same pattern as our attention markers, which already work
cross‑process):

```
~/.claude/hooks/claude-tabs/handoff.json
  { "cwd": "/abs/marketing-site", "sessionId": "…", "ts": 1751800000000 }
```

Flow:

1. Hub writes `handoff.json`, then `openFolder(cwd, forceNewWindow)`.
2. The **new** window's extension, on `activate()`, reads `handoff.json`. If its
   `cwd` matches this window's workspace **and** `ts` is fresh (< 60s), it calls
   `openById(sessionId)` and **deletes** the file (single‑use).
3. Stale/mismatched hand‑offs are ignored and pruned (same self‑healing discipline
   as attention markers).

Edge cases to handle: the folder was already open (no fresh activate → fall back to
a command the running instance polls for on focus); multiple hub clicks in a row
(last‑writer‑wins is fine, single‑use consumption prevents replay); user cancels
the trust prompt on the new window (hand‑off simply expires).

This reuses infrastructure we already trust (a JSON file + read‑on‑activate), so
Phase 3 is small once Phase 2 exists.

---

## 8. Multi-root windows (Phase 4 — Option A, orthogonal)

Independent of the hub: if a **single** window has multiple folders (a `.code-
workspace` multi‑root), aggregate sessions from **all** of them — they genuinely
run in this one window, so everything (open/pin/group/resume) just works.

- Change `extension.ts` to read `workspaceFolders` (all), not `[0]`.
- Build one `SessionStore` per folder; merge `entries[]`; tag each entry with its
  folder for an optional sub‑header.
- Group/pin state stays in `workspaceState` (already per window = per multi‑root
  workspace). No hub needed; no cross‑window constraint.

Small and fully supported; can ship any time, before or after the hub.

---

## 9. Phased delivery

| Phase | Deliverable | Risk |
| --- | --- | --- |
| **1** | Read‑only "All Projects" hub view (this doc's focus) | Low — pure reads, new view |
| 2 | Launch other‑project session → open its folder in a new window | Med — duplicate windows |
| 3 | Auto‑resume via `handoff.json` on the new window's activate | Low‑med — cross‑window timing |
| 4 | Multi‑root aggregation in the current window | Low — additive |

---

## 10. Open questions

1. **Separate view vs. toggle** on the existing tree? (Leaning: separate view.)
2. **Pins**: per‑workspace (a) or machine‑global (b)? (Leaning: (a) for v1.)
3. **Name collisions**: two projects with the same basename → disambiguate with a
   parent segment (`app (frontend/…)`).
4. **Stale projects**: dirs for folders that were deleted/moved. Show them (grayed)
   or hide when the `cwd` no longer exists on disk? (Leaning: hide missing paths,
   with a setting to show all.)
5. **Where the hub lives**: its own Activity Bar view, an entry in the Claude Code
   sidebar container, or both (mirroring how the current tree has two homes).

---

## 11. Concrete first PR (Phase 1) checklist

- [ ] `SessionStore`: allow construction from a known project **dir** (skip resolve).
- [ ] `ProjectRegistry.list()` — enumerate `~/.claude/projects/*`, `readCwd` each,
      `stat` for last‑active, count `*.jsonl`, cache by dir mtime, mark current.
- [ ] Extract the shared session `TreeItem` builder out of `SessionTreeProvider`.
- [ ] `ProjectsTreeProvider` (projects → lazy sessions), read‑only.
- [ ] Register `claudeSessionTabsProjects` view (+ where it lives, §10.5).
- [ ] Click handling: current project opens; other project shows the info message.
- [ ] Shallow watch on `~/.claude/projects` for add/remove; 15s tick refresh.
- [ ] Docs: README section "All Projects hub"; CHANGELOG entry.
```

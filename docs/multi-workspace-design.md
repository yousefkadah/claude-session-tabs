# Multi-Branch / Worktree Support — Design

> Status: **design** (no code yet). Decisions:
> - Core model (2026‑07‑06): **one repo, multiple branches in parallel** — each
>   Claude session on its own branch, via **git worktrees**. Not arbitrary
>   different projects.
> - v1 behavior: **read‑only browse** (organize + show; launching/creating
>   worktrees comes later).
>
> This supersedes the earlier "different projects hub" framing. The generic
> cross‑project hub is kept only as a footnote (§9) since worktrees are the
> actual need.

---

## 1. What we're solving

The user runs **several Claude Code sessions against the same repository, each on
a different branch**, and wants Claude Code Tabs to organize and manage them.

Two shapes of this exist:

- **Sequential** — one working directory, switching branches over time. Different
  sessions ran on different branches (each session records the branch it ran on).
  Only one branch is checked out at any moment.
- **Parallel** — multiple branches checked out *at once*, each in its own working
  directory. This is the interesting case, and it requires **git worktrees**.

---

## 2. The hard constraint: one working dir = one branch

Git does not let a single working directory sit on two branches simultaneously.
So **parallel** work on branches A and B needs **two working directories**:

```
/code/myrepo            → branch main       (the main checkout)
/code/myrepo-feat-a     → branch feat-a     (git worktree add)
/code/myrepo-feat-b     → branch feat-b     (git worktree add)
```

Each worktree is a distinct path, so Claude Code stores its sessions under a
distinct project dir:

```
~/.claude/projects/-code-myrepo/*.jsonl
~/.claude/projects/-code-myrepo-feat-a/*.jsonl
~/.claude/projects/-code-myrepo-feat-b/*.jsonl
```

They all share **one** underlying `.git` (worktrees share the repo's common git
dir). That shared identity is what lets us cluster them as "the same repo, three
branches."

**Consequence — the same routing rule as before:** a session for `feat-a` can only
be *resumed/run* in a window opened on `/code/myrepo-feat-a`. We can't run it inside
the `main` window. So the feature is again **unified visibility + routing**, now
organized by **branch** within **one repo**.

---

## 3. What we already have (this makes it cheap)

| Fact | Where | Why it matters |
| --- | --- | --- |
| Every session parses its **`gitBranch`** | `SessionMeta.gitBranch` (`data/transcript.ts`) | Branch grouping is essentially free. |
| Sessions resolve from a workspace path → project dir | `SessionStore.doResolve` (slug = path with non‑alnum → `-`) | Same slugging maps any worktree path → its project dir. |
| Real `cwd` recoverable from a transcript | `readCwd` | Reverse‑map a project dir → its worktree path. |
| Attention markers are cross‑process files | `data/attentionStore.ts` | Reusable pattern for a future cross‑window hand‑off. |

The key new capability we need is **git awareness**: ask git which worktrees a repo
has, and which branch each is on.

---

## 4. Getting the worktrees: `git worktree list`

From the current workspace, one command enumerates every worktree of this repo:

```
$ git -C <cwd> worktree list --porcelain
worktree /code/myrepo
HEAD 9f1c…
branch refs/heads/main

worktree /code/myrepo-feat-a
HEAD 3ab2…
branch refs/heads/feat-a

worktree /code/myrepo-feat-b
HEAD 77de…
detached
```

Parse into:

```ts
interface Worktree {
  path: string;        // working dir of this worktree
  branch: string;      // "main" | "feat-a" | … ("(detached)" when detached)
  isCurrent: boolean;  // path === this window's workspace folder
  head: string;        // short sha (nice for the tooltip)
}
```

This is **bounded to this repo** (no scanning all of `~/.claude`), fast, and
precise — much better than the generic project hub for this use case. Cache the
result; refresh on focus / the 15s tick / a git‑dir watch (`.git/worktrees`).

Mapping a worktree → its sessions: `slug = path.replace(/[^A-Za-z0-9]/g,'-')` →
`~/.claude/projects/<slug>` → reuse `SessionStore` (constructed directly from that
dir; see the small refactor in §7).

Repo identity (for the header / to confirm they're the same repo): any worktree's
`git rev-parse --git-common-dir` (absolute) is identical across all worktrees of a
repo. Use its parent's basename as the repo name (`myrepo`).

---

## 5. The view

### 5.1 Phase 1a — branch grouping in the *current* workspace (immediate win)

Zero git calls, zero cross‑window concerns: **group the current tree's sessions by
`gitBranch`.** A session's branch is already parsed. Present branch sub‑headers (or
reuse the group mechanism with an auto "Branch: X" bucket):

```
▸ ⎇ main            2 open · 4
    ● Fix parser
    ○ …
▸ ⎇ feat-auth       1 open · 2
    🔔 Redo login
```

This alone covers the *sequential* case and is a small change to `computeGroups`
(add an optional "group by branch" mode alongside the existing user groups). Good
first PR; ships value before any worktree machinery.

### 5.2 Phase 1b — the repo/worktree hub (read‑only)

A dedicated view, `claudeSessionTabsWorktrees` ("Branches"), that shows the current
repo's worktrees as top‑level nodes, each with its sessions:

```
myrepo  (3 worktrees)
  ▸ ⎇ main            /code/myrepo            (current)   2 open · 4
      ● Fix parser
      ○ …
  ▸ ⎇ feat-a          /code/myrepo-feat-a                 1 open · 3
      🔔 Implement X
  ▸ ⎇ feat-b          /code/myrepo-feat-b     (detached)  0 open · 1
```

- Top level = **worktrees of this repo**, current one first, then by last activity.
- Children = that worktree's sessions, reusing the existing session `TreeItem`
  (status dot / bell, hover preview, description) — factor it out so both trees
  share it.
- **Read‑only for other worktrees** (v1): hover previews yes; clicking a session in
  another worktree shows *"This session is on branch `feat-a` (worktree
  `/code/myrepo-feat-a`). Open that worktree to resume it."* No launch yet.
- Sessions in the **current** worktree open normally.

Why a separate view (not a mode on the main tree): the main tree's actions
(pin/group/new‑session‑in‑group) are current‑workspace by nature; a read‑only,
branch‑oriented browser keeps semantics unambiguous. (Same reasoning as the earlier
hub design.)

### 5.3 Not a worktree user yet?

If `git worktree list` returns only one entry, the hub degrades to branch grouping
(5.1) and can show a one‑line hint: *"Tip: `git worktree add ../myrepo-feat feat`
to run a second branch in parallel"* — teaching the workflow the feature is built
around. (Phase 3 automates this.)

---

## 6. State storage

| State | Today | For worktrees |
| --- | --- | --- |
| Groups / pins / show‑inactive | `workspaceState` (per window) | Each worktree window keeps its own — fine. The hub is read‑only, so no cross‑worktree writes in v1. |
| Attention hooks | global files | already cross‑project; unaffected. |

Because worktrees are separate windows with separate `workspaceState`, per‑window
state "just works" and needs no migration. Revisit a machine‑global pin store only
if we later let the hub act on other worktrees. Branch grouping (5.1) is pure view
logic — no new persisted state.

---

## 7. Refactors this needs

- **`SessionStore` from a known dir.** Today it takes `(cwd, override)` and derives
  the project dir. Add a constructor path that accepts a resolved project dir
  directly, so we can build one per worktree without re‑resolving. (Same refactor
  the generic hub wanted — keep the caching/parsing intact.)
- **Shared session `TreeItem` builder.** Extract from `SessionTreeProvider` so the
  worktree tree renders sessions identically.
- **A tiny `git` helper.** `worktreeList(cwd)` and `gitCommonDir(cwd)` shelling out
  via `child_process`, with a short cache and graceful failure (not a git repo →
  hub simply shows nothing and we fall back to branch grouping).

---

## 8. Later phases (documented, not built)

- **Phase 2 — launch a worktree.** Click an other‑worktree session → open its folder
  in a new window: `vscode.openFolder(Uri.file(worktree.path), {forceNewWindow:true})`.
  Caveat: VS Code has no API to *focus* an already‑open window for a folder;
  `openFolder` either replaces the current window (destructive) or force‑opens a new
  one (possible duplicates). Default to a new window.
- **Phase 3 — auto‑resume via hand‑off.** After opening the worktree window, resume
  the exact session using a single‑use `~/.claude/hooks/claude-tabs/handoff.json`
  (`{ cwd, sessionId, ts }`) that the new window reads on `activate()` (fresh < 60s,
  cwd matches), opens, then deletes. Reuses the file‑as‑IPC pattern the attention
  hooks already prove.
- **Phase 4 — create a worktree + session (the big one).** A "New branch session…"
  action:
  1. Ask for a branch name (new or existing).
  2. `git worktree add <sibling-path> <branch>` (or `-b` for a new branch).
  3. `openFolder(newPath, {forceNewWindow:true})` + hand‑off to start a fresh
     Claude session there.
  Mirrors what the Agent tool's `isolation: "worktree"` does, but user‑facing.
  Needs care: where to put the worktree dir (sibling `../repo-<branch>` by default,
  configurable), cleanup of abandoned worktrees (`git worktree prune`/`remove`), and
  never touching a dirty tree.

---

## 9. Footnote: the generic cross‑repo hub

The earlier idea — one view listing **every** project under `~/.claude/projects`,
grouped by repo — still has value for people juggling unrelated repos, and shares
most infrastructure (`ProjectRegistry` scan, read‑only tree, hand‑off). But it is
**not** the current need. If we ever build it, worktrees of one repo become a
sub‑group under that repo's node, i.e. this design nests inside it:
`Repo → Worktree/Branch → Sessions`.

---

## 10. Phased delivery

| Phase | Deliverable | Risk |
| --- | --- | --- |
| **1a** | Group current workspace's sessions by `gitBranch` | Low — view‑only, data already parsed |
| **1b** | Read‑only worktree hub for the current repo (`git worktree list`) | Low‑med — new view + git helper |
| 2 | Launch: open another worktree's folder in a new window | Med — duplicate windows |
| 3 | Auto‑resume the clicked session via `handoff.json` | Low‑med — cross‑window timing |
| 4 | Create worktree + start a new branch session | Med‑high — git mutations, cleanup |

---

## 11. Open questions

1. **1a vs 1b first?** Branch grouping (1a) is a quick, self‑contained win; the
   worktree hub (1b) is the fuller answer. Could ship 1a immediately, 1b next.
2. **Worktree location convention** for Phase 4: sibling `../<repo>-<branch>`?
   A dedicated `~/.claude-worktrees/`? Configurable with a sensible default.
3. **Detached / bare** worktrees: label as "(detached)"; skip the bare repo entry.
4. **Branch renamed / worktree moved** after sessions ran: sessions keep the branch
   recorded at run time — show that, and reconcile against live `worktree list` for
   the header.
5. **Where the hub lives**: own Activity Bar view, inside the Claude Code sidebar
   container, or both (like the current tree's two homes).

---

## 12. Concrete first PR (Phase 1a) checklist

- [ ] `SessionMeta.gitBranch` already present — confirm it's populated for the
      common cases (normal branch, detached HEAD → skip/label).
- [ ] Add a "Group by branch" mode to `computeGroups` (auto buckets keyed by
      branch, ordered current‑branch‑first).
- [ ] Toggle in the view title (like show/hide inactive) to switch between
      user‑groups and branch‑groups.
- [ ] Branch bucket header shows `⎇ <branch>` + open/total counts.
- [ ] README + CHANGELOG.

(Phase 1b checklist: `git` helper `worktreeList`/`gitCommonDir`; `SessionStore`
from‑dir constructor; shared session `TreeItem`; `WorktreesTreeProvider`; register
the view; read‑only click handling; `.git/worktrees` watch + tick refresh.)
```

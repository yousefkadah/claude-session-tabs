import * as vscode from 'vscode';
import { SessionStore } from '../data/sessionStore';
import { GroupStore } from '../data/groupStore';
import { GroupDef, LiveTab, SessionEntry, StripData, StripSession, SubagentInfo } from '../model/types';
import {
  claudeTruncateLabel,
  escapeMd,
  formatRelative,
  formatTokens,
  normalizeLabel,
  truncate,
} from '../util/format';
import { makeSessionTreeItem, statusOf } from './sessionItem';

const DND_MIME = 'application/vnd.claude-session-tabs';
/** Key for the implicit Ungrouped bucket in per-group persisted state (show-inactive). */
export const UNGROUPED_ID = '__ungrouped__';

/** "charts.blue" -> "var(--vscode-charts-blue)" for use in the webview strip. */
function themeColorVar(id: string): string {
  return `var(--vscode-${id.replace(/\./g, '-')})`;
}

/** A subagent whose transcript changed within this window is treated as still running.
 * Wide enough to tolerate gaps while a subagent waits on a long tool call. */
const SUBAGENT_ACTIVE_MS = 60_000;

function isSubagentRunning(s: SubagentInfo): boolean {
  return Date.now() - s.mtimeMs < SUBAGENT_ACTIVE_MS;
}

/** Sort priority: pinned, then needs-action, then active, then open, then closed. */
function rank(e: SessionEntry): number {
  if (e.pinned) {
    return 0;
  }
  switch (statusOf(e)) {
    case 'needs-action':
      return 1;
    case 'active':
      return 2;
    case 'closed':
      return 4;
    default:
      return 3;
  }
}

function sortEntries(list: SessionEntry[]): SessionEntry[] {
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    return r !== 0 ? r : b.meta.mtimeMs - a.meta.mtimeMs;
  });
}

export class GroupTreeNode {
  readonly kind = 'group' as const;
  constructor(
    public group: GroupDef | null,
    public entries: SessionEntry[],
    /** Closed sessions hidden by the "active only" default (0 when revealing them). */
    public hiddenCount = 0,
    /** Whether this group is currently revealing its closed sessions. */
    public showingInactive = false,
    /** The show-inactive persistence key (group id, UNGROUPED_ID, or "branch:<name>"). */
    public key: string = group ? group.id : UNGROUPED_ID,
    /** Set when this bucket is a branch (group-by-branch mode) rather than a user group. */
    public branch?: string,
  ) {}
}

export class SessionTreeNode {
  readonly kind = 'session' as const;
  constructor(public entry: SessionEntry) {}
}

export class SubagentTreeNode {
  readonly kind = 'subagent' as const;
  constructor(public sub: SubagentInfo, public sessionId: string) {}
}

export type TreeNode = GroupTreeNode | SessionTreeNode | SubagentTreeNode;

/** A group with its display-filtered entries and how many closed ones are hidden. */
interface ComputedGroup {
  group: GroupDef | null;
  /** Show-inactive persistence key (group id, UNGROUPED_ID, or "branch:<name>"). */
  key: string;
  /** Set when this bucket is a branch (group-by-branch mode). */
  branch?: string;
  entries: SessionEntry[];
  hidden: number;
  showingInactive: boolean;
}

/** The branch a session ran on, normalized; sessions with no/detached branch share a bucket. */
function branchOf(e: SessionEntry): string {
  const b = e.meta.gitBranch;
  return b && b !== 'HEAD' ? b : '(no branch)';
}

export class SessionTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidBuild = new vscode.EventEmitter<void>();
  /** Fires after build() recomputes entries — the strip webview listens for this. */
  readonly onDidBuild = this._onDidBuild.event;

  readonly dropMimeTypes = [DND_MIME];
  readonly dragMimeTypes = [DND_MIME];

  private entries: SessionEntry[] = [];
  private maxRecent = 25;
  private showClosed = true;
  /** sessionId -> hook marker mtime (ms). Real-time "needs you" flags from Claude Code hooks. */
  private attention = new Map<string, number>();
  /**
   * When the user starts a new session from a group, we latch onto the new tab
   * (its Tab object is stable even while the session has no id yet), show it in
   * the group immediately, and persist the assignment once the session gets a
   * real id. `tab` is set once we've identified the freshly-opened tab.
   */
  private pendingGroup?: { groupId: string; since: number; tab?: vscode.Tab; before: Set<vscode.Tab> };

  constructor(private store: SessionStore, private groups: GroupStore) {}

  /** Queue a new session (opened right after this) to be added to `groupId`. */
  setPendingGroup(groupId: string): void {
    const before = new Set<vscode.Tab>();
    for (const lt of this.liveTabs()) {
      before.add(lt.tab);
    }
    this.pendingGroup = { groupId, since: Date.now(), before };
  }

  /** The editor column where existing Claude tabs live, so a new session opens beside them. */
  getClaudeColumn(): vscode.ViewColumn | undefined {
    return this.liveTabs()[0]?.viewColumn;
  }

  /**
   * Resolve the pending "new session in group" request. Returns the tab we've
   * latched onto (so build() can show it in the group before its id stabilizes).
   */
  private resolvePendingGroup(): vscode.Tab | undefined {
    const p = this.pendingGroup;
    if (!p) {
      return undefined;
    }
    if (Date.now() - p.since > 120_000 || !this.groups.hasGroup(p.groupId)) {
      this.pendingGroup = undefined;
      return undefined;
    }
    // Latch onto the freshly-opened tab: a Claude tab that wasn't open before the
    // click (prefer the active one). Its Tab object stays identical across builds.
    if (!p.tab) {
      const fresh = this.entries.filter((e) => e.live && !p.before.has(e.live.tab));
      const chosen = fresh.find((e) => e.live?.isActive) ?? fresh[0];
      if (chosen?.live) {
        p.tab = chosen.live.tab;
      }
    }
    if (!p.tab) {
      return undefined; // new tab hasn't appeared yet
    }
    // Once that tab's session has a real id, persist the group assignment.
    const entry = this.entries.find((e) => e.live?.tab === p.tab);
    if (!entry) {
      this.pendingGroup = undefined; // tab was closed
      return undefined;
    }
    if (entry.meta.filePath && !this.groups.groupOf(entry.meta.id)) {
      const groupId = p.groupId;
      this.pendingGroup = undefined;
      void this.groups.assign(entry.meta.id, groupId);
      return undefined;
    }
    return p.tab; // still id-less — keep showing it in the group visually
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this._onDidBuild.dispose();
  }

  configure(maxRecent: number, showClosed: boolean): void {
    this.maxRecent = maxRecent;
    this.showClosed = showClosed;
  }

  /** Replace the hook-driven attention markers (sessionId -> marker mtime). */
  setAttention(map: Map<string, number>): void {
    this.attention = map;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Re-read sessions + live tabs and recompute the flat entry list. */
  async build(): Promise<void> {
    const metas = await this.store.list();
    const live = this.liveTabs();
    const used = new Set<LiveTab>();
    const entries: SessionEntry[] = [];

    for (const meta of metas) {
      const label = claudeTruncateLabel(meta.title);
      let match: LiveTab | undefined;
      for (const lt of live) {
        if (!used.has(lt) && normalizeLabel(lt.label) === label) {
          match = lt;
          break;
        }
      }
      if (match) {
        used.add(match);
      }
      entries.push({
        meta,
        open: !!match,
        live: match,
        pinned: this.groups.isPinned(meta.id),
        groupId: this.groups.groupOf(meta.id),
        subagents: await this.store.getSubagents(meta.id),
        attentionMtime: this.attention.get(meta.id),
      });
    }

    // Brand-new tabs that don't yet have a resolvable transcript title. The synthIndex
    // discriminator keeps ids unique when two new tabs share a label+column.
    let synthIndex = 0;
    for (const lt of live) {
      if (used.has(lt)) {
        continue;
      }
      const n = synthIndex++;
      const id = `live:${lt.viewColumn ?? 0}:${lt.label}:${n}`;
      entries.push({
        meta: {
          id,
          filePath: '',
          title: lt.label || 'Claude Code',
          mtimeMs: Number.MAX_SAFE_INTEGER - n,
          pendingAsk: false,
          messageCount: 0,
          contextTokens: 0,
          outputTokens: 0,
          approx: false,
        },
        open: true,
        live: lt,
        pinned: this.groups.isPinned(id),
        groupId: this.groups.groupOf(id),
        subagents: [],
      });
    }

    entries.sort((a, b) => {
      if (a.open !== b.open) {
        return a.open ? -1 : 1;
      }
      return b.meta.mtimeMs - a.meta.mtimeMs;
    });
    this.entries = entries;
    const pendingTab = this.resolvePendingGroup();
    if (pendingTab && this.pendingGroup) {
      // Show the freshly-opened session inside its group before it has a real id.
      const e = this.entries.find((x) => x.live?.tab === pendingTab);
      if (e) {
        e.groupId = this.pendingGroup.groupId;
      }
    }
    this._onDidBuild.fire();
  }

  /** Look up a computed entry by session id (used by strip message handlers). */
  getEntry(id: string): SessionEntry | undefined {
    return this.entries.find((e) => e.meta.id === id);
  }

  private liveTabs(): LiveTab[] {
    const out: LiveTab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputWebview && input.viewType.includes('claudeVSCodePanel')) {
          out.push({
            label: tab.label,
            viewColumn: group.viewColumn,
            isActive: tab.isActive,
            isDirty: tab.isDirty,
            isPinned: tab.isPinned,
            tab,
          });
        }
      }
    }
    return out;
  }

  /** An entry counts as grouped only if its assignment points to an existing group. */
  private isGrouped(e: SessionEntry): boolean {
    return !!e.groupId && this.groups.hasGroup(e.groupId);
  }

  private visibleEntries(): SessionEntry[] {
    const vis: SessionEntry[] = [];
    let recent = 0;
    for (const e of this.entries) {
      const kept = e.open || e.pinned || this.isGrouped(e);
      if (!kept && e.meta.messageCount === 0) {
        continue; // empty transcript the user hasn't pinned/grouped and isn't viewing
      }
      const isRecentOnly = !kept;
      if (isRecentOnly && (!this.showClosed || recent >= this.maxRecent)) {
        continue;
      }
      vis.push(e);
      if (isRecentOnly) {
        recent++;
      }
    }
    return vis;
  }

  /**
   * Apply the per-group "show active only" default. Unless the bucket is revealing its
   * closed sessions, drop the ones that are neither open nor pinned (pinning is an
   * explicit keep-visible signal), reporting how many were hidden. `key` identifies the
   * bucket for show-inactive persistence (group id, UNGROUPED_ID, or "branch:<name>").
   */
  private applyInactiveFilter(
    key: string,
    group: GroupDef | null,
    branch: string | undefined,
    sorted: SessionEntry[],
  ): ComputedGroup {
    const showingInactive = this.groups.isShowInactive(key);
    if (showingInactive) {
      return { key, group, branch, entries: sorted, hidden: 0, showingInactive };
    }
    const entries: SessionEntry[] = [];
    let hidden = 0;
    for (const e of sorted) {
      if (e.open || e.pinned) {
        entries.push(e);
      } else {
        hidden++;
      }
    }
    return { key, group, branch, entries, hidden, showingInactive };
  }

  /** Group the visible entries for the tree — by branch or by user groups per the toggle. */
  private computeGroups(): ComputedGroup[] {
    const vis = this.visibleEntries();
    return this.groups.isGroupByBranch() ? this.computeBranchGroups(vis) : this.computeUserGroups(vis);
  }

  /** Bucket visible entries into the user's named groups + Ungrouped. */
  private computeUserGroups(vis: SessionEntry[]): ComputedGroup[] {
    const byGroup = new Map<string, SessionEntry[]>();
    const ungrouped: SessionEntry[] = [];
    for (const e of vis) {
      if (this.isGrouped(e)) {
        const list = byGroup.get(e.groupId as string);
        if (list) {
          list.push(e);
        } else {
          byGroup.set(e.groupId as string, [e]);
        }
      } else {
        ungrouped.push(e);
      }
    }
    const out: ComputedGroup[] = [];
    for (const g of this.groups.groups) {
      out.push(this.applyInactiveFilter(g.id, g, undefined, sortEntries(byGroup.get(g.id) ?? [])));
    }
    if (ungrouped.length) {
      out.push(this.applyInactiveFilter(UNGROUPED_ID, null, undefined, sortEntries(ungrouped)));
    }
    return out;
  }

  /** Bucket visible entries by the branch each session ran on, most-recent branch first. */
  private computeBranchGroups(vis: SessionEntry[]): ComputedGroup[] {
    const byBranch = new Map<string, SessionEntry[]>();
    for (const e of vis) {
      const b = branchOf(e);
      const list = byBranch.get(b);
      if (list) {
        list.push(e);
      } else {
        byBranch.set(b, [e]);
      }
    }
    const recency = (list: SessionEntry[]): number => list.reduce((m, e) => Math.max(m, e.meta.mtimeMs), 0);
    return [...byBranch.entries()]
      .sort((a, b) => recency(b[1]) - recency(a[1]))
      .map(([branch, list]) => this.applyInactiveFilter(`branch:${branch}`, null, branch, sortEntries(list)));
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.computeGroups().map(
        (c) => new GroupTreeNode(c.group, c.entries, c.hidden, c.showingInactive, c.key, c.branch),
      );
    }
    if (element.kind === 'group') {
      return element.entries.map((e) => new SessionTreeNode(e));
    }
    if (element.kind === 'session') {
      // Only surface subagents that are still active — finished ones are just noise.
      return element.entry.subagents
        .filter(isSubagentRunning)
        .map((s) => new SubagentTreeNode(s, element.entry.meta.id));
    }
    return [];
  }

  /** Serializable snapshot for the webview strip. Always user-groups (branch mode is tree-only). */
  getSnapshot(): StripData {
    const groups = this.computeUserGroups(this.visibleEntries()).map(({ group, entries, hidden, showingInactive }) => ({
      id: group ? group.id : null,
      name: group ? group.name : 'Ungrouped',
      colorVar: group ? themeColorVar(group.color) : null,
      showingInactive,
      hidden,
      sessions: entries.map((e) => this.sessionSnapshot(e)),
    }));
    return {
      groups,
      allGroups: this.groups.groups.map((g) => ({ id: g.id, name: g.name, colorVar: themeColorVar(g.color) })),
    };
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      return this.groupItem(node);
    }
    if (node.kind === 'subagent') {
      return this.subagentItem(node);
    }
    return this.sessionItem(node);
  }

  private subagentItem(node: SubagentTreeNode): vscode.TreeItem {
    const s = node.sub;
    const label = s.description || s.agentType;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = 'sub:' + node.sessionId + ':' + s.agentId;
    item.description = s.agentType;
    item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
    item.contextValue = 'subagent';
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`$(robot) **${escapeMd(s.agentType)}**  ·  $(sync) running\n\n`);
    if (s.description) {
      md.appendMarkdown(`${escapeMd(s.description)}\n\n`);
    }
    md.appendMarkdown(`$(history) ${formatRelative(s.mtimeMs)}`);
    item.tooltip = md;
    item.command = { command: 'claudeSessionTabs.openSubagent', title: 'Open Subagent', arguments: [node] };
    return item;
  }

  private sessionSnapshot(e: SessionEntry): StripSession {
    const m = e.meta;
    return {
      id: m.id,
      title: m.title || 'Claude Code',
      short: truncate(m.title || 'Claude Code', 24),
      open: e.open,
      pinned: e.pinned,
      hasFile: !!m.filePath,
      status: statusOf(e),
      branch: m.gitBranch && m.gitBranch !== 'HEAD' ? m.gitBranch : undefined,
      tokens: m.contextTokens > 0 ? formatTokens(m.contextTokens) + (m.approx ? '~' : '') : undefined,
      rel: formatRelative(m.mtimeMs),
      lastUser: m.lastUserText ? truncate(m.lastUserText, 240) : undefined,
      lastAssistant: m.lastAssistantText ? truncate(m.lastAssistantText, 240) : undefined,
    };
  }

  private groupItem(node: GroupTreeNode): vscode.TreeItem {
    if (node.branch !== undefined) {
      return this.branchItem(node);
    }
    const g = node.group;
    const label = g ? g.name : 'Ungrouped';
    const collapsed = g?.collapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(label, collapsed);
    item.id = 'group:' + node.key;
    item.description = this.bucketDescription(node);
    // The state token drives which eye action (show/hide) is offered inline.
    const base = g ? 'group' : 'ungrouped';
    item.contextValue = `${base} ${node.showingInactive ? 'showing-inactive' : 'hiding-inactive'}`;
    item.iconPath = g
      ? new vscode.ThemeIcon('folder', new vscode.ThemeColor(g.color))
      : new vscode.ThemeIcon('inbox');
    return item;
  }

  /** A branch bucket row (group-by-branch mode). Read-only w.r.t. group editing. */
  private branchItem(node: GroupTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.branch ?? '(no branch)', vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'branch:' + node.key;
    item.description = this.bucketDescription(node);
    item.iconPath = new vscode.ThemeIcon('git-branch');
    // "branch" (not "group") so group rename/delete menus don't apply; the eye toggle does.
    item.contextValue = `branch ${node.showingInactive ? 'showing-inactive' : 'hiding-inactive'}`;
    return item;
  }

  /** "2 open · 5 · 3 hidden" style count line shared by group + branch rows. */
  private bucketDescription(node: GroupTreeNode): string {
    const shown = node.entries.length;
    const open = node.entries.filter((e) => e.open).length;
    const parts: string[] = [];
    if (open && open !== shown) {
      parts.push(`${open} open`);
    }
    if (shown) {
      parts.push(`${shown}`);
    }
    if (node.hiddenCount) {
      parts.push(`${node.hiddenCount} hidden`);
    }
    return parts.join(' · ') || '0';
  }

  private sessionItem(node: SessionTreeNode): vscode.TreeItem {
    const e = node.entry;
    return makeSessionTreeItem(e, {
      // Expandable only when there's a live subagent to show.
      collapsible: e.subagents.some(isSubagentRunning),
      command: e.meta.filePath
        ? { command: 'claudeSessionTabs.openSession', title: 'Open', arguments: [node] }
        : undefined,
    });
  }

  /** Number of open sessions waiting on the user (needs-action) — drives the view badge. */
  getAttentionCount(): number {
    return this.entries.filter((e) => statusOf(e) === 'needs-action').length;
  }

  // --- Drag & drop: move sessions between groups ---

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    const ids = source
      .filter((n): n is SessionTreeNode => n.kind === 'session')
      .map((n) => n.entry.meta.id);
    if (ids.length) {
      dataTransfer.set(DND_MIME, new vscode.DataTransferItem(ids));
    }
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(DND_MIME);
    if (!item) {
      return;
    }
    const ids = item.value as string[];
    let groupId: string | null = null;
    if (target?.kind === 'group') {
      groupId = target.group ? target.group.id : null;
    } else if (target?.kind === 'session') {
      groupId = target.entry.groupId;
    }
    for (const id of ids) {
      await this.groups.assign(id, groupId);
    }
    // GroupStore.onDidChange triggers the rebuild.
  }
}

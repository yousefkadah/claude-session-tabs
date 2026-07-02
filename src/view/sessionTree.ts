import * as vscode from 'vscode';
import { SessionStore } from '../data/sessionStore';
import { GroupStore } from '../data/groupStore';
import { GroupDef, LiveTab, SessionEntry, SessionStatus, StripData, StripSession } from '../model/types';
import {
  claudeTruncateLabel,
  escapeMd,
  formatRelative,
  formatTokens,
  normalizeLabel,
  truncate,
} from '../util/format';

const DND_MIME = 'application/vnd.claude-session-tabs';
const UNGROUPED_ID = '__ungrouped__';

/** "charts.blue" -> "var(--vscode-charts-blue)" for use in the webview strip. */
function themeColorVar(id: string): string {
  return `var(--vscode-${id.replace(/\./g, '-')})`;
}

/** Order sessions within a group: pinned first, then open, then active, then most-recent. */
function sortEntries(list: SessionEntry[]): SessionEntry[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    if (a.open !== b.open) {
      return a.open ? -1 : 1;
    }
    const aActive = a.live?.isActive ? 1 : 0;
    const bActive = b.live?.isActive ? 1 : 0;
    if (aActive !== bActive) {
      return bActive - aActive;
    }
    return b.meta.mtimeMs - a.meta.mtimeMs;
  });
}

export class GroupTreeNode {
  readonly kind = 'group' as const;
  constructor(public group: GroupDef | null, public entries: SessionEntry[]) {}
}

export class SessionTreeNode {
  readonly kind = 'session' as const;
  constructor(public entry: SessionEntry) {}
}

export type TreeNode = GroupTreeNode | SessionTreeNode;

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

  constructor(private store: SessionStore, private groups: GroupStore) {}

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this._onDidBuild.dispose();
  }

  configure(maxRecent: number, showClosed: boolean): void {
    this.maxRecent = maxRecent;
    this.showClosed = showClosed;
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
      });
    }

    // Brand-new tabs that don't yet have a resolvable transcript title.
    let synthIndex = 0;
    for (const lt of live) {
      if (used.has(lt)) {
        continue;
      }
      const id = `live:${lt.viewColumn ?? 0}:${lt.label}`;
      entries.push({
        meta: {
          id,
          filePath: '',
          title: lt.label || 'Claude Code',
          mtimeMs: Number.MAX_SAFE_INTEGER - synthIndex++,
          messageCount: 0,
          contextTokens: 0,
          outputTokens: 0,
          approx: false,
        },
        open: true,
        live: lt,
        pinned: this.groups.isPinned(id),
        groupId: this.groups.groupOf(id),
      });
    }

    entries.sort((a, b) => {
      if (a.open !== b.open) {
        return a.open ? -1 : 1;
      }
      return b.meta.mtimeMs - a.meta.mtimeMs;
    });
    this.entries = entries;
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

  /** Group the currently-visible entries; shared by the tree and the webview strip. */
  private computeGroups(): { group: GroupDef | null; entries: SessionEntry[] }[] {
    const vis = this.visibleEntries();
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
    const out: { group: GroupDef | null; entries: SessionEntry[] }[] = [];
    for (const g of this.groups.groups) {
      out.push({ group: g, entries: sortEntries(byGroup.get(g.id) ?? []) });
    }
    if (ungrouped.length) {
      out.push({ group: null, entries: sortEntries(ungrouped) });
    }
    return out;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.computeGroups().map(({ group, entries }) => new GroupTreeNode(group, entries));
    }
    if (element.kind === 'group') {
      return element.entries.map((e) => new SessionTreeNode(e));
    }
    return [];
  }

  /** Serializable snapshot for the webview strip. */
  getSnapshot(): StripData {
    const groups = this.computeGroups().map(({ group, entries }) => ({
      id: group ? group.id : null,
      name: group ? group.name : 'Ungrouped',
      colorVar: group ? themeColorVar(group.color) : null,
      sessions: entries.map((e) => this.sessionSnapshot(e)),
    }));
    return {
      groups,
      allGroups: this.groups.groups.map((g) => ({ id: g.id, name: g.name, colorVar: themeColorVar(g.color) })),
    };
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node.kind === 'group' ? this.groupItem(node) : this.sessionItem(node);
  }

  private sessionStatus(e: SessionEntry): SessionStatus {
    if (!e.open) {
      return 'closed';
    }
    if (e.live?.isActive) {
      return 'active';
    }
    if (e.live?.isDirty) {
      return 'working';
    }
    return 'open';
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
      status: this.sessionStatus(e),
      branch: m.gitBranch && m.gitBranch !== 'HEAD' ? m.gitBranch : undefined,
      tokens: m.contextTokens > 0 ? formatTokens(m.contextTokens) + (m.approx ? '~' : '') : undefined,
      rel: formatRelative(m.mtimeMs),
      lastUser: m.lastUserText ? truncate(m.lastUserText, 240) : undefined,
      lastAssistant: m.lastAssistantText ? truncate(m.lastAssistantText, 240) : undefined,
    };
  }

  private groupItem(node: GroupTreeNode): vscode.TreeItem {
    const g = node.group;
    const label = g ? g.name : 'Ungrouped';
    const collapsed = g?.collapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(label, collapsed);
    item.id = 'group:' + (g ? g.id : UNGROUPED_ID);
    const openCount = node.entries.filter((e) => e.open).length;
    item.description = openCount ? `${openCount} open · ${node.entries.length}` : `${node.entries.length}`;
    item.contextValue = g ? 'group' : 'ungrouped';
    item.iconPath = g
      ? new vscode.ThemeIcon('folder', new vscode.ThemeColor(g.color))
      : new vscode.ThemeIcon('inbox');
    return item;
  }

  private sessionItem(node: SessionTreeNode): vscode.TreeItem {
    const e = node.entry;
    const item = new vscode.TreeItem(e.meta.title || 'Claude Code', vscode.TreeItemCollapsibleState.None);
    item.id = 'session:' + e.meta.id;
    item.description = this.sessionDescription(e);
    item.tooltip = this.buildTooltip(e);
    item.iconPath = this.sessionIcon(e);
    item.contextValue = this.sessionContext(e);
    if (e.meta.filePath) {
      item.command = { command: 'claudeSessionTabs.openSession', title: 'Open', arguments: [node] };
    }
    return item;
  }

  private sessionDescription(e: SessionEntry): string {
    const parts: string[] = [];
    if (e.pinned) {
      parts.push('📌');
    }
    if (e.meta.gitBranch && e.meta.gitBranch !== 'HEAD') {
      parts.push(e.meta.gitBranch);
    }
    if (e.meta.contextTokens > 0) {
      parts.push(formatTokens(e.meta.contextTokens));
    }
    parts.push(formatRelative(e.meta.mtimeMs));
    return parts.join(' · ');
  }

  private sessionIcon(e: SessionEntry): vscode.ThemeIcon {
    if (e.open) {
      if (e.live?.isActive) {
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      }
      if (e.live?.isDirty) {
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.orange'));
      }
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
    }
    if (e.pinned) {
      return new vscode.ThemeIcon('pinned');
    }
    return new vscode.ThemeIcon('circle-outline');
  }

  private sessionContext(e: SessionEntry): string {
    const flags = ['session'];
    flags.push(e.open ? 'open' : 'closed');
    flags.push(e.pinned ? 'pinned' : 'unpinned');
    flags.push(e.groupId ? 'grouped' : 'ungrouped');
    return flags.join(' ');
  }

  private buildTooltip(e: SessionEntry): vscode.MarkdownString {
    const m = e.meta;
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true; // isTrusted stays false — command links won't run
    md.appendMarkdown(`### ${escapeMd(m.title || 'Claude Code')}\n\n`);

    let status: string;
    if (e.open) {
      status = e.live?.isActive
        ? '$(circle-filled) Active'
        : e.live?.isDirty
          ? '$(circle-filled) Working'
          : '$(circle-filled) Open';
    } else {
      status = '$(circle-outline) Closed';
    }
    md.appendMarkdown(status);
    if (e.pinned) {
      md.appendMarkdown('  ·  $(pinned) Pinned');
    }
    md.appendMarkdown('\n\n');

    if (m.lastUserText) {
      md.appendMarkdown(`**You:** ${escapeMd(truncate(m.lastUserText, 220))}\n\n`);
    }
    if (m.lastAssistantText) {
      md.appendMarkdown(`**Claude:** ${escapeMd(truncate(m.lastAssistantText, 220))}\n\n`);
    }

    const meta: string[] = [];
    if (m.gitBranch) {
      meta.push(`$(git-branch) ${escapeMd(m.gitBranch)}`);
    }
    if (m.contextTokens > 0) {
      meta.push(`$(database) ${formatTokens(m.contextTokens)}${m.approx ? '~' : ''} ctx`);
    }
    if (m.messageCount > 0) {
      meta.push(`$(comment-discussion) ${m.messageCount}${m.approx ? '+' : ''} msg`);
    }
    meta.push(`$(history) ${formatRelative(m.mtimeMs)}`);
    if (meta.length) {
      md.appendMarkdown('---\n\n' + meta.join('  ·  '));
    }
    if (m.filePath) {
      md.appendMarkdown(`\n\n$(file) \`${escapeMd(m.id)}\``);
    }
    return md;
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

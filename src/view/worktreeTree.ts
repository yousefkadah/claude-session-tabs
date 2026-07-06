import * as vscode from 'vscode';
import * as path from 'path';
import { SessionStore } from '../data/sessionStore';
import { Worktree, gitCommonDir, listWorktrees, repoNameFromCommonDir } from '../data/git';
import { SessionEntry, SessionMeta } from '../model/types';
import { sessionDescription, buildSessionTooltip } from './sessionItem';

/** A worktree of the current repo, with its (transcript-derived) sessions. */
export class WorktreeNode {
  readonly kind = 'worktree' as const;
  constructor(public wt: Worktree, public isCurrent: boolean, public entries: SessionEntry[]) {}
}

/** A session under a worktree. Cross-window, so status is transcript-based, not live. */
export class WtSessionNode {
  readonly kind = 'wtsession' as const;
  constructor(public entry: SessionEntry, public worktree: Worktree, public isCurrent: boolean) {}
}

/** An informational / hint row (not a repo, only one worktree, etc.). */
export class WtMessageNode {
  readonly kind = 'message' as const;
  constructor(public label: string, public icon = 'info', public command?: vscode.Command) {}
}

export type WtNode = WorktreeNode | WtSessionNode | WtMessageNode;

function wrapEntries(metas: SessionMeta[]): SessionEntry[] {
  // From another window we can't see live tabs, so every session is treated as
  // not-open; "waiting for you" still comes through from the transcript (pendingAsk).
  return metas.map((meta) => ({
    meta,
    open: false,
    pinned: false,
    groupId: null,
    subagents: [],
    attentionMtime: undefined,
  }));
}

/**
 * Read-only tree of the current repo's git worktrees, each with its sessions —
 * the "run different branches in parallel" hub. Clicking a session in another
 * worktree offers to open that worktree in a new window (handled by a command).
 */
export class WorktreeTreeProvider implements vscode.TreeDataProvider<WtNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WtNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private nodes: WorktreeNode[] = [];
  private message?: WtMessageNode;
  private repoName?: string;
  private readonly stores = new Map<string, SessionStore>();

  constructor(private cwd: string | undefined) {}

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private storeFor(worktreePath: string): SessionStore {
    let s = this.stores.get(worktreePath);
    if (!s) {
      s = new SessionStore(worktreePath);
      this.stores.set(worktreePath, s);
    }
    return s;
  }

  /** Re-enumerate worktrees and their sessions. */
  async build(): Promise<void> {
    this.nodes = [];
    this.message = undefined;
    if (!this.cwd) {
      this.message = new WtMessageNode('Open a folder to see its worktrees.');
      return;
    }
    const worktrees = await listWorktrees(this.cwd);
    if (worktrees.length === 0) {
      this.message = new WtMessageNode('Not a git repository.', 'source-control');
      return;
    }
    const common = await gitCommonDir(this.cwd);
    this.repoName = common ? repoNameFromCommonDir(common) : undefined;

    const usable = worktrees.filter((w) => !w.bare);
    for (const wt of usable) {
      const isCurrent = !!this.cwd && path.resolve(wt.path) === path.resolve(this.cwd);
      let entries: SessionEntry[] = [];
      try {
        entries = wrapEntries(await this.storeFor(wt.path).list());
      } catch {
        entries = [];
      }
      this.nodes.push(new WorktreeNode(wt, isCurrent, entries));
    }
    // Current worktree first, then most recently active.
    const lastActive = (n: WorktreeNode): number => n.entries.reduce((m, e) => Math.max(m, e.meta.mtimeMs), 0);
    this.nodes.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || lastActive(b) - lastActive(a));

    if (usable.length <= 1) {
      this.message = new WtMessageNode('New branch session…', 'add', {
        command: 'claudeSessionTabs.newBranchSession',
        title: 'New branch session',
      });
    }
  }

  getChildren(element?: WtNode): WtNode[] {
    if (!element) {
      const roots: WtNode[] = [...this.nodes];
      if (this.message) {
        roots.push(this.message);
      }
      return roots;
    }
    if (element.kind === 'worktree') {
      return element.entries.map((e) => new WtSessionNode(e, element.wt, element.isCurrent));
    }
    return [];
  }

  getTreeItem(node: WtNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.command) {
        item.command = node.command;
      }
      return item;
    }
    if (node.kind === 'worktree') {
      return this.worktreeItem(node);
    }
    return this.wtSessionItem(node);
  }

  private worktreeItem(node: WorktreeNode): vscode.TreeItem {
    const wt = node.wt;
    const item = new vscode.TreeItem(wt.branch, vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'wt:' + wt.path;
    const parts: string[] = [];
    if (node.isCurrent) {
      parts.push('current');
    }
    parts.push(`${node.entries.length}`);
    parts.push(path.basename(wt.path));
    item.description = parts.join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      'git-branch',
      node.isCurrent ? new vscode.ThemeColor('charts.green') : undefined,
    );
    item.contextValue = node.isCurrent ? 'worktree current' : 'worktree other';
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`$(git-branch) **${wt.branch}**${node.isCurrent ? '  ·  this window' : ''}\n\n`);
    md.appendMarkdown(`$(folder) \`${wt.path}\``);
    if (wt.head) {
      md.appendMarkdown(`\n\n$(git-commit) ${wt.head}`);
    }
    item.tooltip = md;
    return item;
  }

  private wtSessionItem(node: WtSessionNode): vscode.TreeItem {
    const e = node.entry;
    const item = new vscode.TreeItem(e.meta.title || 'Claude Code', vscode.TreeItemCollapsibleState.None);
    item.id = `wt:${node.worktree.path}:${e.meta.id}`;
    item.description = sessionDescription(e);
    item.tooltip = buildSessionTooltip(e);
    // Cross-window we can't know live state; surface only the transcript's "waiting for you".
    item.iconPath = e.meta.pendingAsk
      ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon('circle-outline');
    item.contextValue = node.isCurrent ? 'wtsession current' : 'wtsession other';
    item.command = {
      command: 'claudeSessionTabs.openWorktreeSession',
      title: 'Open',
      arguments: [node],
    };
    return item;
  }
}

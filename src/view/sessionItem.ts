import * as vscode from 'vscode';
import { SessionEntry, SessionStatus } from '../model/types';
import { escapeMd, formatRelative, formatTokens, truncate } from '../util/format';

/**
 * Whether the session is waiting on you. Two signals, either one is enough:
 * - `pendingAsk` (transcript): Claude's last turn ended on an unanswered
 *   AskUserQuestion / ExitPlanMode. Authoritative but lags transcript writes.
 * - a hook marker (`attentionMtime`): fired the instant Claude asked, so it's
 *   lag-free. We trust it until the transcript catches up *past* it and shows
 *   the ask resolved — that reconciliation clears a stale marker without flicker.
 */
export function needsAction(e: SessionEntry): boolean {
  if (e.meta.pendingAsk) {
    return true;
  }
  return e.attentionMtime !== undefined && e.meta.mtimeMs <= e.attentionMtime;
}

/**
 * Session status from what we can observe:
 * - closed: no live tab.
 * - needs-action: waiting on you (see needsAction).
 * - active: the tab you're currently viewing.
 * - open: open but idle.
 */
export function statusOf(e: SessionEntry): SessionStatus {
  if (!e.open) {
    return 'closed';
  }
  if (needsAction(e)) {
    return 'needs-action';
  }
  if (e.live?.isActive) {
    return 'active';
  }
  return 'open';
}

export function sessionIcon(e: SessionEntry): vscode.ThemeIcon {
  switch (statusOf(e)) {
    case 'needs-action':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow'));
    case 'active':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    case 'open':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
    default:
      return e.pinned ? new vscode.ThemeIcon('pinned') : new vscode.ThemeIcon('circle-outline');
  }
}

export function sessionDescription(e: SessionEntry): string {
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

export function sessionContext(e: SessionEntry): string {
  const flags = ['session'];
  flags.push(e.open ? 'open' : 'closed');
  flags.push(e.pinned ? 'pinned' : 'unpinned');
  flags.push(e.groupId ? 'grouped' : 'ungrouped');
  return flags.join(' ');
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: '$(circle-filled) Active',
  'needs-action': '$(bell-dot) Waiting for you',
  open: '$(circle-filled) Open',
  closed: '$(circle-outline) Closed',
};

export function buildSessionTooltip(e: SessionEntry): vscode.MarkdownString {
  const m = e.meta;
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true; // isTrusted stays false — command links won't run
  md.appendMarkdown(`### ${escapeMd(m.title || 'Claude Code')}\n\n`);

  md.appendMarkdown(STATUS_LABEL[statusOf(e)]);
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

export interface SessionItemOptions {
  /** Show an expand chevron (the main tree uses this for live subagents). */
  collapsible?: boolean;
  /** Click command. */
  command?: vscode.Command;
  /** TreeItem id prefix (must be unique within a tree). Defaults to "session:". */
  idPrefix?: string;
}

/** Build the shared session row (icon, description, hover, context) used by both trees. */
export function makeSessionTreeItem(e: SessionEntry, opts: SessionItemOptions = {}): vscode.TreeItem {
  const collapsible = opts.collapsible
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(e.meta.title || 'Claude Code', collapsible);
  item.id = (opts.idPrefix ?? 'session:') + e.meta.id;
  item.description = sessionDescription(e);
  item.tooltip = buildSessionTooltip(e);
  item.iconPath = sessionIcon(e);
  item.contextValue = sessionContext(e);
  if (opts.command) {
    item.command = opts.command;
  }
  return item;
}

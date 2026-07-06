import * as vscode from 'vscode';
import * as path from 'path';
import { SessionStore } from './data/sessionStore';
import { GroupStore } from './data/groupStore';
import { AttentionStore } from './data/attentionStore';
import { addWorktree, listBranches } from './data/git';
import { writeNewSessionHandoff, writeOpenHandoff } from './data/handoff';
import { SessionTreeProvider, TreeNode, UNGROUPED_ID } from './view/sessionTree';
import { WtNode } from './view/worktreeTree';
import { StripHandlers } from './view/strip/stripView';
import { showSubagentPanel } from './view/subagent/subagentPanel';
import { formatRelative, truncate } from './util/format';

const COLORS: { label: string; id: string }[] = [
  { label: 'Blue', id: 'charts.blue' },
  { label: 'Green', id: 'charts.green' },
  { label: 'Orange', id: 'charts.orange' },
  { label: 'Purple', id: 'charts.purple' },
  { label: 'Red', id: 'charts.red' },
  { label: 'Yellow', id: 'charts.yellow' },
  { label: 'Neutral', id: 'charts.foreground' },
];

/** Shared services the commands and the strip act on. */
export interface ExtensionServices {
  store: SessionStore;
  groups: GroupStore;
  provider: SessionTreeProvider;
  attention: AttentionStore;
  /** Fire-and-forget rebuild of the tree + strip. */
  rebuild: () => void;
  /** Fire-and-forget rebuild of the Worktrees view. */
  refreshWorktrees: () => void;
  /** Re-evaluate hook install state: (re)start/stop the watcher and rescan markers. */
  syncAttention: () => void;
}

export function registerCommands(context: vscode.ExtensionContext, services: ExtensionServices): void {
  const { store, groups, provider, attention, rebuild, refreshWorktrees, syncAttention } = services;
  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn as (...args: unknown[]) => unknown));
  };

  reg('claudeSessionTabs.refresh', () => {
    store.invalidateAll();
    rebuild();
    refreshWorktrees();
  });

  reg('claudeSessionTabs.openSession', async (node?: TreeNode) => {
    if (node?.kind !== 'session') {
      return;
    }
    if (!node.entry.meta.filePath) {
      void vscode.window.showInformationMessage('This session tab is already open.');
      return;
    }
    // Reveal an already-open session in place; open a closed one beside the Claude tabs.
    const column = node.entry.open ? undefined : provider.getClaudeColumn();
    await openById(node.entry.meta.id, column);
  });

  reg('claudeSessionTabs.closeTab', async (node?: TreeNode) => {
    if (node?.kind === 'session' && node.entry.live) {
      await vscode.window.tabGroups.close(node.entry.live.tab);
    }
  });

  reg('claudeSessionTabs.openSubagent', async (node?: TreeNode) => {
    if (node?.kind === 'subagent') {
      await showSubagentPanel(node.sub);
    }
  });

  // Open a session from the Worktrees view. In this worktree → open normally.
  // In another worktree → open that folder in a new window and resume it there.
  reg('claudeSessionTabs.openWorktreeSession', async (node?: WtNode) => {
    if (!node || node.kind !== 'wtsession') {
      return;
    }
    const id = node.entry.meta.id;
    if (node.isCurrent) {
      const e = provider.getEntry(id);
      await openById(id, e?.open ? undefined : provider.getClaudeColumn());
      return;
    }
    const title = node.entry.meta.title || 'Session';
    const pick = await vscode.window.showInformationMessage(
      `"${title}" is on branch ${node.worktree.branch} in another worktree. Open that worktree in a new window and resume it?`,
      'Open in New Window',
    );
    if (pick !== 'Open in New Window') {
      return;
    }
    writeOpenHandoff(node.worktree.path, id, Date.now());
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.path), {
      forceNewWindow: true,
    });
  });

  // Create a git worktree for a branch and start a fresh Claude session in it.
  reg('claudeSessionTabs.newBranchSession', async () => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      void vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    const branches = await listBranches(cwd);
    type Item = vscode.QuickPickItem & { branch?: string; create?: boolean };
    const items: Item[] = [
      { label: '$(add) New branch…', create: true },
      ...branches.map((b) => ({ label: `$(git-branch) ${b}`, branch: b })),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Branch to run in a new worktree',
    });
    if (!pick) {
      return;
    }
    let branch: string;
    let createBranch: boolean;
    if (pick.create) {
      const name = await vscode.window.showInputBox({
        prompt: 'New branch name',
        placeHolder: 'e.g. feature/login',
        validateInput: (v) => (v.trim() ? undefined : 'Enter a branch name'),
      });
      if (!name || !name.trim()) {
        return;
      }
      branch = name.trim();
      createBranch = true;
    } else {
      branch = pick.branch as string;
      createBranch = false;
    }
    const safe = branch.replace(/[^A-Za-z0-9._-]/g, '-');
    const defaultDest = path.join(path.dirname(cwd), `${path.basename(cwd)}-${safe}`);
    const dest = await vscode.window.showInputBox({
      prompt: 'Worktree location (a new folder)',
      value: defaultDest,
      valueSelection: [defaultDest.length, defaultDest.length],
    });
    if (!dest || !dest.trim()) {
      return;
    }
    const res = await addWorktree(cwd, dest.trim(), branch, createBranch);
    if (!res.ok) {
      void vscode.window.showErrorMessage(`git worktree add failed: ${res.error}`);
      return;
    }
    writeNewSessionHandoff(dest.trim(), Date.now());
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest.trim()), {
      forceNewWindow: true,
    });
  });

  reg('claudeSessionTabs.newGroup', async () => {
    await createGroupInteractive(groups);
  });

  reg('claudeSessionTabs.newSessionInGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'group' || !node.group) {
      return;
    }
    // Queue the group; the next new session that appears joins it (after its first message).
    provider.setPendingGroup(node.group.id);
    await startNewConversation(provider.getClaudeColumn());
    void vscode.window.showInformationMessage(`The next new session will be added to "${node.group.name}".`);
  });

  reg('claudeSessionTabs.renameGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'group' || !node.group) {
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Rename group', value: node.group.name });
    if (name && name.trim()) {
      await groups.renameGroup(node.group.id, name.trim());
    }
  });

  reg('claudeSessionTabs.recolorGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'group' || !node.group) {
      return;
    }
    const color = await pickColor();
    if (color) {
      await groups.recolorGroup(node.group.id, color);
    }
  });

  reg('claudeSessionTabs.deleteGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'group' || !node.group) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete group "${node.group.name}"? Sessions stay — they just become ungrouped.`,
      { modal: true },
      'Delete',
    );
    if (choice === 'Delete') {
      await groups.deleteGroup(node.group.id);
    }
  });

  reg('claudeSessionTabs.assignToGroup', async (node?: TreeNode) => {
    if (node?.kind !== 'session') {
      return;
    }
    const target = await pickGroupTarget(groups);
    if (target !== undefined) {
      await groups.assign(node.entry.meta.id, target);
    }
  });

  reg('claudeSessionTabs.removeFromGroup', async (node?: TreeNode) => {
    if (node?.kind === 'session') {
      await groups.assign(node.entry.meta.id, null);
    }
  });

  reg('claudeSessionTabs.togglePin', async (node?: TreeNode) => {
    if (node?.kind === 'session') {
      await groups.togglePin(node.entry.meta.id);
    }
  });

  // Show/Hide closed sessions in a bucket (both share one handler; two commands only
  // so the inline icon can differ by current state). node.key covers groups, Ungrouped,
  // and branch buckets alike.
  const toggleInactive = async (node?: TreeNode): Promise<void> => {
    if (node?.kind !== 'group') {
      return;
    }
    await groups.toggleShowInactive(node.key);
  };
  reg('claudeSessionTabs.showInactive', toggleInactive);
  reg('claudeSessionTabs.hideInactive', toggleInactive);

  // Toggle between grouping by user groups and grouping by git branch.
  reg('claudeSessionTabs.groupByBranch', async () => {
    await groups.setGroupByBranch(true);
    void vscode.commands.executeCommand('setContext', 'claudeSessionTabs.branchMode', true);
  });
  reg('claudeSessionTabs.groupByGroup', async () => {
    await groups.setGroupByBranch(false);
    void vscode.commands.executeCommand('setContext', 'claudeSessionTabs.branchMode', false);
  });

  reg('claudeSessionTabs.enableAttention', async () => {
    const proceed = await vscode.window.showInformationMessage(
      attention.describeInstall(),
      { modal: true },
      'Install hooks',
    );
    if (proceed !== 'Install hooks') {
      return;
    }
    try {
      await attention.install();
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't install hooks: ${(e as Error).message}`);
      return;
    }
    syncAttention();
    void vscode.window.showInformationMessage(
      'Real-time attention enabled. Start a new Claude Code session (or reload the window) so it picks up the hooks.',
    );
  });

  reg('claudeSessionTabs.disableAttention', async () => {
    await attention.uninstall();
    syncAttention();
    void vscode.window.showInformationMessage('Real-time attention disabled — hooks removed from ~/.claude.');
  });

  reg('claudeSessionTabs.search', async () => {
    const metas = await store.list();
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = metas.map((m) => ({
      label: m.title || 'Claude Code',
      description: formatRelative(m.mtimeMs),
      detail: m.lastUserText ? '💬 ' + truncate(m.lastUserText, 90) : undefined,
      id: m.id,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Search Claude sessions',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (pick) {
      await openById(pick.id, provider.getEntry(pick.id)?.open ? undefined : provider.getClaudeColumn());
    }
  });

}

/** Message handler for the webview strip, sharing the same services. */
export function createStripHandlers(services: ExtensionServices): StripHandlers {
  const { store, groups, provider, rebuild } = services;
  return {
    onMessage: (msg) => {
      switch (msg.type) {
        case 'open': {
          if (!msg.id) {
            return;
          }
          const e = provider.getEntry(msg.id);
          if (e && !e.meta.filePath) {
            void vscode.window.showInformationMessage('This session tab is already open.');
            return;
          }
          void openById(msg.id, e?.open ? undefined : provider.getClaudeColumn());
          break;
        }
        case 'close': {
          const e = msg.id ? provider.getEntry(msg.id) : undefined;
          if (e?.live) {
            void vscode.window.tabGroups.close(e.live.tab);
          }
          break;
        }
        case 'pin':
          if (msg.id) {
            void groups.togglePin(msg.id);
          }
          break;
        case 'move':
          if (msg.id) {
            void groups.assign(msg.id, msg.groupId ?? null);
          }
          break;
        case 'toggleInactive':
          void groups.toggleShowInactive(msg.groupId ?? UNGROUPED_ID);
          break;
        case 'newGroup':
          void createGroupInteractive(groups);
          break;
        case 'search':
          void vscode.commands.executeCommand('claudeSessionTabs.search');
          break;
        case 'refresh':
          store.invalidateAll();
          rebuild();
          break;
        default:
          break;
      }
    },
  };
}

export async function openById(sessionId: string, column?: vscode.ViewColumn): Promise<void> {
  // For an already-open session, pass ViewColumn.Active so Claude reveals/focuses it
  // in place. For a closed one, pass the Claude tabs' column so it opens beside them
  // rather than over the code editor.
  const target = column ?? vscode.ViewColumn.Active;
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, target);
  } catch {
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
    } catch {
      try {
        const uri = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
        await vscode.env.openExternal(vscode.Uri.parse(uri));
      } catch {
        void vscode.window.showErrorMessage(
          'Could not open the session. Make sure the Claude Code extension is installed and enabled.',
        );
      }
    }
  }
}

/**
 * Open a fresh Claude conversation as an editor tab so we can detect it. Opens in
 * `column` (where the existing Claude tabs live) when known, so the new session
 * lands beside them instead of over the code editor.
 */
export async function startNewConversation(column?: vscode.ViewColumn): Promise<void> {
  const target = column ?? vscode.ViewColumn.Active;
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, undefined, target);
  } catch {
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
    } catch {
      void vscode.window.showErrorMessage(
        'Could not start a new Claude session. Make sure the Claude Code extension is installed.',
      );
    }
  }
}

async function pickColor(): Promise<string | undefined> {
  const pick = await vscode.window.showQuickPick(
    COLORS.map((c) => ({ label: `$(circle-filled) ${c.label}`, id: c.id })),
    { placeHolder: 'Group color' },
  );
  return pick?.id;
}

/** Returns the chosen group id, null for "Ungrouped", or undefined if cancelled. */
async function pickGroupTarget(groups: GroupStore): Promise<string | null | undefined> {
  type Item = vscode.QuickPickItem & { id: string | null | '__new__' };
  const items: Item[] = [
    { label: '$(circle-slash) Ungrouped', id: null },
    ...groups.groups.map((g) => ({ label: `$(folder) ${g.name}`, id: g.id as string | null })),
    { label: '$(new-folder) New group…', id: '__new__' as const },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Move session to group' });
  if (!pick) {
    return undefined;
  }
  if (pick.id === '__new__') {
    const g = await createGroupInteractive(groups);
    return g ? g.id : undefined;
  }
  return pick.id;
}

async function createGroupInteractive(groups: GroupStore) {
  const name = await vscode.window.showInputBox({ prompt: 'Group name', placeHolder: 'e.g. Feature work' });
  if (!name || !name.trim()) {
    return undefined;
  }
  const color = await pickColor();
  if (!color) {
    return undefined;
  }
  return groups.createGroup(name.trim(), color);
}

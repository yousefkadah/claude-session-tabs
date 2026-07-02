import * as vscode from 'vscode';
import { SessionStore } from './data/sessionStore';
import { GroupStore } from './data/groupStore';
import { SessionTreeProvider, TreeNode } from './view/sessionTree';
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
  /** Fire-and-forget rebuild of the tree + strip. */
  rebuild: () => void;
}

export function registerCommands(context: vscode.ExtensionContext, services: ExtensionServices): void {
  const { store, groups, provider, rebuild } = services;
  const reg = (id: string, fn: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn as (...args: unknown[]) => unknown));
  };

  reg('claudeSessionTabs.refresh', () => {
    store.invalidateAll();
    rebuild();
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

async function openById(sessionId: string, column?: vscode.ViewColumn): Promise<void> {
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
async function startNewConversation(column?: vscode.ViewColumn): Promise<void> {
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

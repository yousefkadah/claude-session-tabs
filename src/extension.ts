import * as vscode from 'vscode';
import { SessionStore } from './data/sessionStore';
import { GroupStore } from './data/groupStore';
import { AttentionStore } from './data/attentionStore';
import { GroupTreeNode, SessionTreeProvider, TreeNode } from './view/sessionTree';
import { StripViewProvider } from './view/strip/stripView';
import { ExtensionServices, createStripHandlers, registerCommands } from './commands';
import { debounce } from './util/async';

export function activate(context: vscode.ExtensionContext): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const cfg = () => vscode.workspace.getConfiguration('claudeSessionTabs');
  const override = cfg().get<string>('projectDirectory')?.trim() || undefined;

  const store = new SessionStore(cwd, override);
  const groups = new GroupStore(context.workspaceState);
  const provider = new SessionTreeProvider(store, groups);
  provider.configure(cfg().get('maxRecentSessions', 25), cfg().get('showClosedSessions', true));

  const treeOptions: vscode.TreeViewOptions<TreeNode> = {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
    canSelectMany: true,
  };
  // Two homes, one data source: a standalone "Claude Code Tabs" container in the
  // Activity Bar, plus a mirror inside the Claude Code sidebar (shown while the
  // Claude Code extension is active). Both share the provider, so they stay in sync.
  const primaryView = vscode.window.createTreeView('claudeSessionTabs', treeOptions);
  const inlineView = vscode.window.createTreeView('claudeSessionTabsInline', treeOptions);
  context.subscriptions.push(primaryView, inlineView, provider, groups);

  for (const v of [primaryView, inlineView]) {
    context.subscriptions.push(
      v.onDidCollapseElement((e) => {
        if (e.element instanceof GroupTreeNode && e.element.group) {
          void groups.setCollapsed(e.element.group.id, true);
        }
      }),
      v.onDidExpandElement((e) => {
        if (e.element instanceof GroupTreeNode && e.element.group) {
          void groups.setCollapsed(e.element.group.id, false);
        }
      }),
    );
  }

  // Tracks deactivation so async setup (below) doesn't register after teardown.
  let disposed = false;
  context.subscriptions.push({ dispose: () => (disposed = true) });

  // "needs-action" count on the view icon (sessions where Claude asked and is waiting).
  const updateBadge = (): void => {
    const n = provider.getAttentionCount();
    const badge =
      n > 0 ? { value: n, tooltip: `${n} session${n === 1 ? '' : 's'} waiting for you` } : undefined;
    primaryView.badge = badge;
    inlineView.badge = badge;
  };

  // Serialize rebuilds; coalesce bursts of tab events.
  let building = false;
  let pending = false;
  const rebuild = async (): Promise<void> => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      await provider.build();
      provider.refresh();
      updateBadge();
    } finally {
      building = false;
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  };
  const debouncedRebuild = debounce(() => void rebuild(), 250);

  // Real-time "needs you" bell, driven by Claude Code hooks (opt-in). Hooks write
  // marker files into attention.d; we watch that directory and re-scan on change.
  const attention = new AttentionStore(context.extensionUri);
  let attentionWatcher: vscode.FileSystemWatcher | undefined;
  const refreshAttention = (): void => {
    provider.setAttention(attention.scan());
    void rebuild();
  };
  const syncAttention = (): void => {
    const installed = attention.isInstalled();
    void vscode.commands.executeCommand('setContext', 'claudeSessionTabs.attentionInstalled', installed);
    if (installed && !attentionWatcher && !disposed) {
      attention.ensureDir();
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(AttentionStore.attentionDir), '*'),
      );
      w.onDidChange(refreshAttention);
      w.onDidCreate(refreshAttention);
      w.onDidDelete(refreshAttention);
      attentionWatcher = w;
      context.subscriptions.push(w);
    } else if (!installed && attentionWatcher) {
      attentionWatcher.dispose();
      attentionWatcher = undefined;
      provider.setAttention(new Map());
    }
    refreshAttention();
  };

  const services: ExtensionServices = {
    store,
    groups,
    provider,
    attention,
    rebuild: () => void rebuild(),
    syncAttention,
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(debouncedRebuild),
    vscode.window.tabGroups.onDidChangeTabGroups(debouncedRebuild),
    groups.onDidChange(() => void rebuild()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSessionTabs')) {
        provider.configure(cfg().get('maxRecentSessions', 25), cfg().get('showClosedSessions', true));
        void rebuild();
      }
    }),
  );

  // Watch the transcript directory so hovers/state stay fresh as sessions progress.
  void store.resolveDir().then((dir) => {
    if (!dir || disposed) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), '*.jsonl'),
    );
    if (disposed) {
      watcher.dispose(); // extension was deactivated during dir resolution
      return;
    }
    const onFs = (uri: vscode.Uri): void => {
      store.invalidate(uri.fsPath);
      debouncedRebuild();
    };
    watcher.onDidChange(onFs);
    watcher.onDidCreate(onFs);
    watcher.onDidDelete(onFs);
    context.subscriptions.push(watcher);
  });

  // Keep relative timestamps ("2m ago") current.
  // Periodic tick: refresh relative times and drop subagents that are no longer active.
  const timer = setInterval(() => {
    provider.refresh();
    updateBadge();
  }, 15_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  registerCommands(context, services);

  const strip = new StripViewProvider(context.extensionUri, provider, createStripHandlers(services));
  context.subscriptions.push(
    strip,
    vscode.window.registerWebviewViewProvider(StripViewProvider.viewType, strip, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  void rebuild();
  // Sets the installed context key and, if hooks are already installed, starts
  // the attention watcher and does an initial scan.
  syncAttention();
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}

import * as vscode from 'vscode';
import { SessionStore } from './data/sessionStore';
import { GroupStore } from './data/groupStore';
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
  // Our own container, plus a mirror inside the Claude Code sidebar (when present).
  const view = vscode.window.createTreeView('claudeSessionTabs', treeOptions);
  const inlineView = vscode.window.createTreeView('claudeSessionTabsInline', treeOptions);
  context.subscriptions.push(view, inlineView, provider, groups);

  // Persist group collapse/expand from either tree view.
  for (const v of [view, inlineView]) {
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
    } finally {
      building = false;
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  };
  const debouncedRebuild = debounce(() => void rebuild(), 250);
  const services: ExtensionServices = { store, groups, provider, rebuild: () => void rebuild() };

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
  const timer = setInterval(() => provider.refresh(), 60_000);
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
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}

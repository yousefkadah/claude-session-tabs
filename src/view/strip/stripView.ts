import * as vscode from 'vscode';
import { SessionTreeProvider } from '../sessionTree';
import { renderStripHtml } from './stripHtml';

export interface StripMessage {
  type: 'open' | 'close' | 'pin' | 'move' | 'newGroup' | 'search' | 'refresh' | 'ready';
  id?: string;
  groupId?: string | null;
}

export interface StripHandlers {
  onMessage(msg: StripMessage): void;
}

/**
 * A webview view (lives in the bottom panel) rendering a horizontal, Chrome-like
 * tab strip: colored group containers, tab chips with status dots, a custom hover
 * preview card, close/pin buttons, and drag-to-group. It shares its data with the
 * sidebar tree via SessionTreeProvider.
 */
export class StripViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'claudeSessionTabsStripView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly provider: SessionTreeProvider,
    private readonly handlers: StripHandlers,
  ) {
    this.provider.onDidBuild(() => this.post());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = renderStripHtml(view.webview.cspSource, makeNonce());
    view.webview.onDidReceiveMessage((msg: StripMessage) => {
      if (msg?.type === 'ready') {
        this.post();
      } else {
        this.handlers.onMessage(msg);
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post();
      }
    });
  }

  private post(): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'data', data: this.provider.getSnapshot() });
    }
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

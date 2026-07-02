import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { SubagentInfo } from '../../model/types';

interface Step {
  kind: 'text' | 'tool';
  text: string;
}

// One panel per subagent; clicking again reveals + refreshes it.
const panels = new Map<string, vscode.WebviewPanel>();

/** Open (or reveal) a read-only panel showing what a subagent did. */
export async function showSubagentPanel(sub: SubagentInfo): Promise<void> {
  const title = truncate(sub.description || sub.agentType, 40);
  let panel = panels.get(sub.agentId);
  if (panel) {
    panel.title = title;
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel('claudeSubagent', title, vscode.ViewColumn.Active, {
      enableScripts: false,
      retainContextWhenHidden: true,
    });
    panels.set(sub.agentId, panel);
    panel.onDidDispose(() => panels.delete(sub.agentId));
  }
  const { task, steps } = await readSteps(sub.filePath);
  panel.webview.html = renderHtml(sub, task, steps);
}

async function readSteps(filePath: string): Promise<{ task: string; steps: Step[] }> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return { task: '', steps: [] };
  }
  let task = '';
  const steps: Step[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    let r: { type?: string; message?: { content?: unknown } };
    try {
      r = JSON.parse(s);
    } catch {
      continue;
    }
    const content = r.message?.content;
    if (r.type === 'user') {
      const t = textOf(content);
      if (t && !task) {
        task = t; // the first user message is the task prompt handed to the subagent
      }
    } else if (r.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== 'object') {
          continue;
        }
        const block = c as { type?: string; text?: unknown; name?: unknown };
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          steps.push({ kind: 'text', text: block.text.trim() });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          steps.push({ kind: 'tool', text: block.name });
        }
      }
    }
  }
  return { task, steps };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n')
      .trim();
  }
  return '';
}

function renderHtml(sub: SubagentInfo, task: string, steps: Step[]): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const body = steps.length
    ? steps
        .map((s) =>
          s.kind === 'tool'
            ? `<div class="tool">$(tool) ${esc(s.text)}</div>`.replace('$(tool)', '🔧')
            : `<div class="text">${esc(s.text).replace(/\n/g, '<br/>')}</div>`,
        )
        .join('')
    : '<p class="muted">No activity recorded yet.</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size,13px);
         color: var(--vscode-foreground); padding: 14px 18px; line-height: 1.5; }
  h2 { margin: 0 0 2px; font-size: 18px; }
  .type { color: var(--vscode-descriptionForeground); margin: 0 0 14px; }
  .task { background: var(--vscode-textBlockQuote-background);
          border-left: 3px solid var(--vscode-textBlockQuote-border);
          padding: 8px 12px; border-radius: 4px; margin: 0 0 16px; white-space: pre-wrap; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em;
       color: var(--vscode-descriptionForeground); margin: 18px 0 8px; }
  .text { margin: 0 0 12px; white-space: normal; }
  .tool { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
          color: var(--vscode-charts-blue); margin: 0 0 8px; }
  .muted { color: var(--vscode-descriptionForeground); }
</style></head>
<body>
  <h2>🤖 ${esc(sub.agentType)}</h2>
  ${sub.description ? `<p class="type">${esc(sub.description)}</p>` : ''}
  ${task ? `<div class="task"><b>Task</b>\n${esc(task)}</div>` : ''}
  <h3>What it did</h3>
  ${body}
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function truncate(s: string, n: number): string {
  const clean = (s || 'Subagent').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

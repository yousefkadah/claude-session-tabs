/**
 * Renders the webview strip document. Pure function of the webview CSP source and
 * a per-load nonce — no VS Code API access, so it is trivially testable.
 */
export function renderStripHtml(cspSource: string, nonce: string): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource}`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: transparent;
    overflow: hidden;
  }
  #root { display: flex; flex-direction: column; height: 100vh; }
  .toolbar {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 6px; flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .toolbar .spacer { flex: 1; }
  .btn {
    all: unset; cursor: pointer; padding: 3px 8px; border-radius: 4px;
    color: var(--vscode-foreground); opacity: 0.85; font-size: 12px;
  }
  .btn:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .strip {
    flex: 1 1 auto; display: flex; align-items: center; gap: 10px;
    padding: 8px; overflow-x: auto; overflow-y: hidden; white-space: nowrap;
  }
  .strip::-webkit-scrollbar { height: 8px; }
  .strip::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
  .group {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 6px 5px 8px; border-radius: 9px;
    border: 1px solid color-mix(in srgb, var(--gc, var(--vscode-panel-border)) 55%, transparent);
    background: color-mix(in srgb, var(--gc, transparent) 10%, transparent);
    flex: 0 0 auto;
  }
  .group.dragover { outline: 2px dashed var(--gc, var(--vscode-focusBorder)); outline-offset: 1px; }
  .group-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
    color: var(--gc, var(--vscode-descriptionForeground));
    padding: 0 2px; max-width: 120px; overflow: hidden; text-overflow: ellipsis;
  }
  .ungrouped { border-style: dashed; }
  .tabs { display: inline-flex; align-items: center; gap: 6px; }
  .tab {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 6px 5px 9px; border-radius: 7px; cursor: pointer;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    max-width: 220px; flex: 0 0 auto;
  }
  .tab:hover { border-color: var(--vscode-focusBorder); }
  .tab.active { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
  .tab.closed { opacity: 0.6; }
  .tab .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-blue); flex: 0 0 auto; }
  .tab .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab .pin { font-size: 10px; opacity: 0.7; }
  .tab .actions { display: none; align-items: center; gap: 2px; }
  .tab:hover .actions { display: inline-flex; }
  .iconbtn {
    all: unset; cursor: pointer; width: 16px; height: 16px; line-height: 16px;
    text-align: center; border-radius: 3px; font-size: 12px; opacity: 0.8;
  }
  .iconbtn:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .empty { color: var(--vscode-descriptionForeground); padding: 8px; font-size: 12px; }
  #pop {
    position: fixed; z-index: 50; display: none; max-width: 340px;
    padding: 10px 12px; border-radius: 8px;
    background: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    white-space: normal; pointer-events: none; font-size: 12px;
  }
  #pop .h { font-weight: 600; margin-bottom: 6px; }
  #pop .row { margin: 3px 0; line-height: 1.4; }
  #pop .k { color: var(--vscode-descriptionForeground); }
  #pop .meta { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="root">
  <div class="toolbar">
    <button class="btn" data-cmd="search" title="Search sessions">🔍 Search</button>
    <button class="btn" data-cmd="newGroup" title="New group">＋ Group</button>
    <span class="spacer"></span>
    <button class="btn" data-cmd="refresh" title="Refresh">⟳</button>
  </div>
  <div class="strip" id="strip"></div>
</div>
<div id="pop"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const strip = document.getElementById('strip');
  const pop = document.getElementById('pop');
  let data = { groups: [], allGroups: [] };

  const DOT = {
    active: 'var(--vscode-charts-green)',
    open: 'var(--vscode-charts-blue)',
    closed: 'var(--vscode-descriptionForeground)',
  };

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function render() {
    strip.innerHTML = '';
    const groups = data.groups || [];
    if (!groups.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No Claude Code sessions in this workspace yet.';
      strip.appendChild(e);
      return;
    }
    for (const g of groups) {
      const gEl = document.createElement('div');
      gEl.className = 'group' + (g.id === null ? ' ungrouped' : '');
      if (g.colorVar) gEl.style.setProperty('--gc', g.colorVar);
      const targetGroup = g.id;
      gEl.addEventListener('dragover', (ev) => { ev.preventDefault(); gEl.classList.add('dragover'); });
      gEl.addEventListener('dragleave', () => gEl.classList.remove('dragover'));
      gEl.addEventListener('drop', (ev) => {
        ev.preventDefault(); gEl.classList.remove('dragover');
        const id = ev.dataTransfer.getData('text/plain');
        if (id) vscode.postMessage({ type: 'move', id, groupId: targetGroup });
      });

      const label = document.createElement('span');
      label.className = 'group-label';
      label.textContent = g.name + ' · ' + g.sessions.length;
      gEl.appendChild(label);

      const tabs = document.createElement('div');
      tabs.className = 'tabs';
      for (const s of g.sessions) tabs.appendChild(makeTab(s));
      gEl.appendChild(tabs);
      strip.appendChild(gEl);
    }
  }

  function makeTab(s) {
    const t = document.createElement('div');
    t.className = 'tab ' + s.status + (s.status === 'active' ? ' active' : '');
    t.draggable = true;
    t.addEventListener('dragstart', (ev) => ev.dataTransfer.setData('text/plain', s.id));
    t.addEventListener('click', () => vscode.postMessage({ type: 'open', id: s.id }));
    t.addEventListener('mouseenter', (ev) => showPop(ev, s));
    t.addEventListener('mousemove', (ev) => positionPop(ev));
    t.addEventListener('mouseleave', hidePop);

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = DOT[s.status] || DOT.open;
    t.appendChild(dot);

    if (s.pinned) {
      const pin = document.createElement('span');
      pin.className = 'pin'; pin.textContent = '📌';
      t.appendChild(pin);
    }

    const title = document.createElement('span');
    title.className = 'title'; title.textContent = s.short;
    t.appendChild(title);

    const actions = document.createElement('span');
    actions.className = 'actions';
    actions.appendChild(iconBtn(s.pinned ? '📍' : '📌', s.pinned ? 'Unpin' : 'Pin', (ev) => {
      ev.stopPropagation(); vscode.postMessage({ type: 'pin', id: s.id });
    }));
    if (s.open) {
      actions.appendChild(iconBtn('✕', 'Close tab', (ev) => {
        ev.stopPropagation(); vscode.postMessage({ type: 'close', id: s.id });
      }));
    }
    t.appendChild(actions);
    return t;
  }

  function iconBtn(label, title, onClick) {
    const b = document.createElement('button');
    b.className = 'iconbtn'; b.textContent = label; b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function showPop(ev, s) {
    let html = '<div class="h">' + esc(s.title) + '</div>';
    const statusLabel = { active: 'Active', open: 'Open', closed: 'Closed' }[s.status];
    html += '<div class="row"><span class="k">' + statusLabel + (s.pinned ? ' · Pinned' : '') + '</span></div>';
    if (s.lastUser) html += '<div class="row"><span class="k">You:</span> ' + esc(s.lastUser) + '</div>';
    if (s.lastAssistant) html += '<div class="row"><span class="k">Claude:</span> ' + esc(s.lastAssistant) + '</div>';
    const meta = [];
    if (s.branch) meta.push('⌥ ' + esc(s.branch));
    if (s.tokens) meta.push(esc(s.tokens) + ' ctx');
    meta.push(esc(s.rel));
    html += '<div class="meta">' + meta.join('  ·  ') + '</div>';
    pop.innerHTML = html;
    pop.style.display = 'block';
    positionPop(ev);
  }

  function positionPop(ev) {
    if (pop.style.display !== 'block') return;
    const pad = 12;
    let x = ev.clientX + 14;
    let y = ev.clientY + 16;
    const r = pop.getBoundingClientRect();
    if (x + r.width + pad > window.innerWidth) x = window.innerWidth - r.width - pad;
    if (y + r.height + pad > window.innerHeight) y = ev.clientY - r.height - 16;
    pop.style.left = Math.max(pad, x) + 'px';
    pop.style.top = Math.max(pad, y) + 'px';
  }

  function hidePop() { pop.style.display = 'none'; }

  document.querySelectorAll('.toolbar .btn').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ type: b.getAttribute('data-cmd') }));
  });

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'data') { data = ev.data.data; render(); }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/**
 * Reproduce the Claude Code extension's tab-label truncation so we can match
 * a session title against a live tab's label.
 * (webview: title.length > 25 ? title.slice(0,24) + '…' : title, fallback "Claude Code")
 */
export function claudeTruncateLabel(title: string): string {
  const t = title && title.trim() ? title : 'Claude Code';
  return t.length > 25 ? t.substring(0, 24) + '…' : t;
}

/** Collapse whitespace and truncate for compact display. */
export function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

export function formatTokens(n: number): string {
  if (n >= 1000) {
    return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  }
  return String(n);
}

export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.round(diff / 1000);
  if (s < 45) {
    return 'just now';
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.round(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.round(h / 24);
  if (d < 7) {
    return `${d}d ago`;
  }
  const w = Math.round(d / 7);
  if (w < 5) {
    return `${w}w ago`;
  }
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

/** Escape the characters that would otherwise be interpreted as Markdown in a tooltip. */
export function escapeMd(s: string): string {
  return s.replace(/[\\`*_[\]<>|]/g, (r) => '\\' + r);
}

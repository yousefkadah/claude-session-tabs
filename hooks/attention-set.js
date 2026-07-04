#!/usr/bin/env node
/*
 * Claude Code Tabs — attention SET hook.
 *
 * Registered by the extension on:
 *   - PreToolUse  (matcher: AskUserQuestion|ExitPlanMode)  → Claude is asking you
 *   - Notification (notification_type: permission_prompt)  → Claude needs permission
 *
 * Writes a per-session marker file that the extension watches, so the
 * "needs you" bell lights up instantly — no waiting on the transcript, which
 * Claude Code doesn't flush in real time.
 *
 * Contract: read the hook payload from stdin, do the side effect, exit 0 with
 * no stdout so the tool call is always allowed. Never throw.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw || '{}');
    // The Notification hook also fires for non-attention events; only permission
    // prompts count. PreToolUse payloads carry no notification_type, so they pass.
    if (j.notification_type && j.notification_type !== 'permission_prompt') {
      return;
    }
    const sid = String(j.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!sid) {
      return;
    }
    const dir = path.join(os.homedir(), '.claude', 'hooks', 'claude-tabs', 'attention.d');
    fs.mkdirSync(dir, { recursive: true });
    // Overwrite (not append) so the file's mtime tracks the latest attention event.
    fs.writeFileSync(path.join(dir, sid), String(j.cwd || ''));
  } catch {
    // A hook must never interrupt Claude Code — swallow everything.
  }
});

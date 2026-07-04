#!/usr/bin/env node
/*
 * Claude Code Tabs — attention CLEAR hook.
 *
 * Registered by the extension on UserPromptSubmit (you replied). Removes the
 * session's marker file so the "needs you" bell turns off immediately.
 *
 * If this hook ever misses (e.g. a plan approved without a prompt submit), the
 * extension self-heals: a marker is ignored once the transcript advances past
 * it, so a stale file never keeps the bell lit.
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
    const sid = String(j.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!sid) {
      return;
    }
    const f = path.join(os.homedir(), '.claude', 'hooks', 'claude-tabs', 'attention.d', sid);
    fs.rmSync(f, { force: true });
  } catch {
    // Never interrupt Claude Code.
  }
});

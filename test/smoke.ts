/**
 * Headless smoke test for the pure data layer (no vscode runtime dependency).
 * Exercises the real SessionStore + transcript parser + formatters against the
 * live ~/.claude transcripts for whatever directory this is run from.
 *
 * Run with: npm test
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from '../src/data/sessionStore';
import { claudeConfigDir } from '../src/util/claudeDir';
import { claudeTruncateLabel, formatRelative, formatTokens, normalizeLabel, truncate } from '../src/util/format';

let failures = 0;
function check(name: string, cond: boolean, extra?: string): void {
  const mark = cond ? '✓' : '✗';
  if (!cond) {
    failures++;
  }
  console.log(`  ${mark} ${name}${extra ? '  — ' + extra : ''}`);
}

async function main(): Promise<void> {
  console.log('format utils');
  check('truncate collapses whitespace', truncate('a\n\n  b   c', 100) === 'a b c');
  check('truncate adds ellipsis', truncate('abcdefghij', 5) === 'abcd…');
  check('formatTokens k-suffix', formatTokens(113402) === '113k' && formatTokens(4100) === '4.1k');
  check('formatTokens small', formatTokens(950) === '950');
  check('claudeTruncateLabel <=25 passthrough', claudeTruncateLabel('short title') === 'short title');
  check(
    'claudeTruncateLabel >25 truncates to 24+…',
    claudeTruncateLabel('x'.repeat(40)) === 'x'.repeat(24) + '…',
  );
  check('claudeTruncateLabel collapses newlines', claudeTruncateLabel('fix\nthe bug') === 'fix the bug');
  check('claudeTruncateLabel empty -> Claude Code', claudeTruncateLabel('   ') === 'Claude Code');
  check('normalizeLabel matches truncated', normalizeLabel('fix   the\tbug') === 'fix the bug');
  check('formatRelative just now', formatRelative(Date.now()) === 'just now');
  check('formatRelative minutes', formatRelative(Date.now() - 5 * 60_000) === '5m ago');

  console.log('\nSessionStore against real ~/.claude transcripts');
  const cwd = process.cwd();
  const store = new SessionStore(cwd);
  const dir = await store.resolveDir();
  check('resolveDir found a directory', !!dir, dir);

  const sessions = await store.list();

  if (sessions.length === 0) {
    // Expected on CI / a fresh machine with no ~/.claude transcripts.
    console.log('  (no local transcripts found — skipping real-data checks)');
  } else {
    const withTitles = sessions.filter((s) => s.title && s.title.trim().length > 0);
    check('every session has a title', withTitles.length === sessions.length);

    check(
      'no sidechain/subagent transcripts leaked',
      sessions.every((s) => !s.filePath.includes('subagents')),
    );

    const idsUnique = new Set(sessions.map((s) => s.id)).size === sessions.length;
    check('session ids are unique', idsUnique);

    check('parsed metadata is well-formed', sessions.every((s) => s.messageCount >= 0 && s.contextTokens >= 0));

    const cached = await store.list(); // second call should hit the mtime cache
    check('cached list is stable', cached.length === sessions.length);

    console.log('\nsample (as the tree/strip would show):');
    for (const s of sessions.slice(0, 8)) {
      const parts = [
        s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null,
        s.contextTokens ? formatTokens(s.contextTokens) : null,
        formatRelative(s.mtimeMs),
      ].filter(Boolean);
      console.log(`  • ${claudeTruncateLabel(s.title).padEnd(26)} ${parts.join(' · ')}`);
    }
  }

  console.log('\nCLAUDE_CONFIG_DIR');
  check(
    'claudeConfigDir falls back to ~/.claude',
    claudeConfigDir({}) === path.join(os.homedir(), '.claude'),
  );
  check('claudeConfigDir ignores a blank value', claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' }) === path.join(os.homedir(), '.claude'));
  check('claudeConfigDir honours the env var', claudeConfigDir({ CLAUDE_CONFIG_DIR: '/tmp/alt-claude' }) === '/tmp/alt-claude');

  const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tabs-cfg-'));
  const altCwd = '/work/alt-profile.project';
  const altProject = path.join(altRoot, 'projects', altCwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(altProject, { recursive: true });
  fs.writeFileSync(
    path.join(altProject, 'abc123.jsonl'),
    JSON.stringify({ type: 'user', cwd: altCwd, message: { role: 'user', content: 'hello from alt profile' } }) + '\n',
  );
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = altRoot;
  try {
    const altStore = new SessionStore(altCwd);
    check('SessionStore resolves under CLAUDE_CONFIG_DIR', (await altStore.resolveDir()) === altProject);
    const altSessions = await altStore.list();
    check('SessionStore lists sessions under CLAUDE_CONFIG_DIR', altSessions.length === 1 && altSessions[0].id === 'abc123');
  } finally {
    if (prevCfg === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevCfg;
    }
    fs.rmSync(altRoot, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

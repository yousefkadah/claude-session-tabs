/**
 * Headless smoke test for the pure data layer (no vscode runtime dependency).
 * Exercises the real SessionStore + transcript parser + formatters against the
 * live ~/.claude transcripts for whatever directory this is run from.
 *
 * Run with: npm test
 */
import { SessionStore } from '../src/data/sessionStore';
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

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

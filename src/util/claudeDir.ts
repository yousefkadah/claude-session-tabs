import * as os from 'os';
import * as path from 'path';

/**
 * Claude Code's config directory. Claude Code reads it from `CLAUDE_CONFIG_DIR`
 * and falls back to `~/.claude`; transcripts live under `<dir>/projects` and
 * hooks in `<dir>/settings.json`, so the extension must follow the same rule or
 * it never sees sessions from a non-default config dir.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.claude');
}

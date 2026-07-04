import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const TABS_DIR = path.join(HOOKS_DIR, 'claude-tabs');
const ATTENTION_DIR = path.join(TABS_DIR, 'attention.d');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const SET_SCRIPT = path.join(TABS_DIR, 'attention-set.js');
const CLEAR_SCRIPT = path.join(TABS_DIR, 'attention-clear.js');

/** Every hook command we write contains this token, so we can find/strip ours. */
const MARKER = 'claude-tabs';
/** A marker older than this is treated as abandoned and pruned (safety net). */
const STALE_MS = 24 * 60 * 60 * 1000;

/** One Claude Code hook we register, described for both install and the consent prompt. */
interface HookSpec {
  event: string;
  matcher?: string;
  command: string;
  purpose: string;
}

function specs(): HookSpec[] {
  return [
    {
      event: 'PreToolUse',
      matcher: 'AskUserQuestion|ExitPlanMode',
      command: `node "${SET_SCRIPT}"`,
      purpose: 'Claude asked a question or presented a plan → light the bell',
    },
    {
      event: 'Notification',
      command: `node "${SET_SCRIPT}"`,
      purpose: 'Claude needs permission → light the bell',
    },
    {
      event: 'UserPromptSubmit',
      command: `node "${CLEAR_SCRIPT}"`,
      purpose: 'You replied → clear the bell',
    },
  ];
}

/**
 * Bridges Claude Code hooks to the tree's real-time "needs you" bell.
 *
 * Hooks fire the instant Claude asks (unlike the transcript, which lags), each
 * writing a marker file under attention.d/<session_id>. This store installs
 * those hooks into ~/.claude/settings.json, scans the marker directory, and
 * keeps it tidy. The extension watches the directory and re-scans on change.
 */
export class AttentionStore {
  static readonly attentionDir = ATTENTION_DIR;

  constructor(private extensionUri: vscode.Uri) {}

  /** True when our hook commands are present in ~/.claude/settings.json. */
  isInstalled(): boolean {
    const hooks = this.readSettings()?.hooks;
    if (!hooks || typeof hooks !== 'object') {
      return false;
    }
    return Object.values(hooks).some(
      (arr) => Array.isArray(arr) && arr.some((e) => JSON.stringify(e).includes(MARKER)),
    );
  }

  ensureDir(): void {
    try {
      fs.mkdirSync(ATTENTION_DIR, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  /**
   * Current per-session attention markers: sessionId -> marker mtime (ms).
   * Prunes markers older than STALE_MS as it goes so the directory self-cleans.
   */
  scan(): Map<string, number> {
    const out = new Map<string, number>();
    let names: string[];
    try {
      names = fs.readdirSync(ATTENTION_DIR);
    } catch {
      return out; // directory doesn't exist yet
    }
    const now = Date.now();
    for (const name of names) {
      const full = path.join(ATTENTION_DIR, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) {
          continue;
        }
        if (now - st.mtimeMs > STALE_MS) {
          fs.rmSync(full, { force: true });
          continue;
        }
        out.set(name, st.mtimeMs);
      } catch {
        /* skip unreadable entry */
      }
    }
    return out;
  }

  /** Human-readable summary of exactly what install() will change (consent prompt). */
  describeInstall(): string {
    const lines = specs().map((s) => `• ${s.event}${s.matcher ? ` (${s.matcher})` : ''} — ${s.purpose}`);
    return (
      `Claude Code Tabs will add these hooks to ${SETTINGS_FILE}:\n\n` +
      lines.join('\n') +
      `\n\nHelper scripts are copied to ${TABS_DIR}. Nothing is sent anywhere — the hooks only ` +
      `touch a local marker folder the extension watches. You can undo this any time with ` +
      `"Disable Real-time Attention".`
    );
  }

  /** Copy the hook scripts and merge our hook entries into settings.json. */
  async install(): Promise<void> {
    fs.mkdirSync(TABS_DIR, { recursive: true });
    this.copyScript('attention-set.js', SET_SCRIPT);
    this.copyScript('attention-clear.js', CLEAR_SCRIPT);
    this.ensureDir();

    const settings = this.readSettingsOrThrow();
    const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<
      string,
      unknown[]
    >;
    for (const s of specs()) {
      const arr = (Array.isArray(hooks[s.event]) ? hooks[s.event] : []) as unknown[];
      const cleaned = arr.filter((e) => !JSON.stringify(e).includes(MARKER));
      cleaned.push({
        ...(s.matcher ? { matcher: s.matcher } : {}),
        hooks: [{ type: 'command', command: s.command }],
      });
      hooks[s.event] = cleaned;
    }
    settings.hooks = hooks;
    this.writeSettings(settings);
  }

  /** Remove our hook entries (leaving any user hooks intact) and helper scripts. */
  async uninstall(): Promise<void> {
    const settings = this.readSettings();
    const hooks = settings?.hooks;
    if (settings && hooks && typeof hooks === 'object') {
      for (const event of Object.keys(hooks)) {
        const arr = hooks[event];
        if (!Array.isArray(arr)) {
          continue;
        }
        const kept = arr.filter((e) => !JSON.stringify(e).includes(MARKER));
        if (kept.length) {
          hooks[event] = kept;
        } else {
          delete hooks[event];
        }
      }
      if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
      }
      this.writeSettings(settings);
    }
    // Best-effort cleanup of scripts + markers.
    try {
      fs.rmSync(TABS_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // --- internals ---

  private copyScript(name: string, dest: string): void {
    const src = vscode.Uri.joinPath(this.extensionUri, 'hooks', name).fsPath;
    fs.copyFileSync(src, dest);
  }

  private readSettings(): Record<string, any> | undefined {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** Like readSettings, but refuses to proceed on an unparseable (non-empty) file. */
  private readSettingsOrThrow(): Record<string, any> {
    let raw: string;
    try {
      raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    } catch {
      return {}; // no settings yet — we'll create it
    }
    if (!raw.trim()) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(
        `Could not parse ${SETTINGS_FILE}. Fix or remove it, then try again — the extension won't overwrite a file it can't read.`,
      );
    }
  }

  private writeSettings(settings: Record<string, any>): void {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  }
}

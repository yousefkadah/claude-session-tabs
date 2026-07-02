import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SessionMeta, SubagentInfo } from '../model/types';
import { parseSession, readCwd } from './transcript';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  meta: SessionMeta | null;
}

/**
 * Reads Claude Code session transcripts from ~/.claude/projects/<slug>/*.jsonl.
 * Results are cached by (mtime,size) so unchanged files are never re-parsed.
 */
export class SessionStore {
  private cache = new Map<string, CacheEntry>();
  private subCache = new Map<string, { mtimeMs: number; subs: SubagentInfo[] }>();
  private projectDir: string | undefined;
  private resolving: Promise<string | undefined> | undefined;

  constructor(private cwd: string | undefined, private overrideDir?: string) {}

  get directory(): string | undefined {
    return this.projectDir;
  }

  async resolveDir(): Promise<string | undefined> {
    if (this.overrideDir) {
      this.projectDir = this.overrideDir;
      return this.projectDir;
    }
    if (this.projectDir) {
      return this.projectDir;
    }
    if (!this.resolving) {
      this.resolving = this.doResolve();
    }
    this.projectDir = await this.resolving;
    this.resolving = undefined;
    return this.projectDir;
  }

  private async doResolve(): Promise<string | undefined> {
    if (!this.cwd) {
      return undefined;
    }
    const base = path.join(os.homedir(), '.claude', 'projects');
    // Claude derives the slug by replacing every non-alphanumeric character with '-'.
    const slug = this.cwd.replace(/[^A-Za-z0-9]/g, '-');
    const candidate = path.join(base, slug);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Fall back to scanning: match a project dir by the cwd recorded inside its transcripts.
    }
    try {
      const dirs = await fs.readdir(base, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) {
          continue;
        }
        const full = path.join(base, d.name);
        let files: string[];
        try {
          files = (await fs.readdir(full)).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        // Scan files until one yields a cwd; a directory belongs to exactly one cwd.
        for (const file of files) {
          const cwd = await readCwd(path.join(full, file));
          if (cwd === undefined) {
            continue;
          }
          if (cwd === this.cwd) {
            return full;
          }
          break; // this directory is a different cwd — stop scanning it
        }
      }
    } catch {
      // ~/.claude/projects may not exist yet.
    }
    return candidate; // best guess even if it does not exist yet
  }

  async list(): Promise<SessionMeta[]> {
    const dir = await this.resolveDir();
    if (!dir) {
      return [];
    }
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const f of files) {
      const fp = path.join(dir, f);
      try {
        const meta = await this.readMeta(fp);
        if (meta) {
          metas.push(meta);
        }
      } catch {
        // Unreadable/locked file — skip it.
      }
    }
    metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return metas;
  }

  /**
   * List the subagents Claude spawned in a session, from its sidecar dir
   * `<projectDir>/<sessionId>/subagents/agent-*.meta.json`. Cached by the dir's mtime.
   */
  async getSubagents(sessionId: string): Promise<SubagentInfo[]> {
    const dir = await this.resolveDir();
    if (!dir) {
      return [];
    }
    const subDir = path.join(dir, sessionId, 'subagents');
    let dirMtime: number;
    try {
      dirMtime = (await fs.stat(subDir)).mtimeMs;
    } catch {
      return []; // no subagents for this session
    }
    const cached = this.subCache.get(sessionId);
    if (cached && cached.mtimeMs === dirMtime) {
      return cached.subs;
    }
    let files: string[];
    try {
      files = (await fs.readdir(subDir)).filter((f) => f.endsWith('.meta.json'));
    } catch {
      return [];
    }
    const subs: SubagentInfo[] = [];
    for (const f of files) {
      const agentId = f.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      try {
        const meta = JSON.parse(await fs.readFile(path.join(subDir, f), 'utf8'));
        let mtimeMs = dirMtime;
        try {
          mtimeMs = (await fs.stat(path.join(subDir, `agent-${agentId}.jsonl`))).mtimeMs;
        } catch {
          // transcript not written yet
        }
        subs.push({
          agentId,
          agentType: typeof meta.agentType === 'string' ? meta.agentType : 'agent',
          description: typeof meta.description === 'string' ? meta.description : '',
          mtimeMs,
        });
      } catch {
        // skip unreadable/partial meta
      }
    }
    subs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.subCache.set(sessionId, { mtimeMs: dirMtime, subs });
    return subs;
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private async readMeta(filePath: string): Promise<SessionMeta | null> {
    const st = await fs.stat(filePath);
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.meta;
    }
    const meta = await parseSession(filePath, st.size, st.mtimeMs);
    this.cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  }
}

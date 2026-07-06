import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HANDOFF_FILE = path.join(os.homedir(), '.claude', 'hooks', 'claude-tabs', 'handoff.json');
/** A hand-off older than this is ignored (the target window never opened in time). */
const FRESH_MS = 60_000;

/**
 * A single-use instruction left for the window that's about to open on `cwd`:
 * resume `sessionId`, or start a fresh session when `sessionId` is absent.
 */
export interface Handoff {
  cwd: string;
  sessionId?: string;
  ts: number;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function write(h: Handoff): void {
  try {
    fs.mkdirSync(path.dirname(HANDOFF_FILE), { recursive: true });
    fs.writeFileSync(HANDOFF_FILE, JSON.stringify(h));
  } catch {
    /* best-effort */
  }
}

/** Ask the window opening on `cwd` to resume this exact session. */
export function writeOpenHandoff(cwd: string, sessionId: string, now: number): void {
  write({ cwd, sessionId, ts: now });
}

/** Ask the window opening on `cwd` to start a fresh session. */
export function writeNewSessionHandoff(cwd: string, now: number): void {
  write({ cwd, ts: now });
}

function remove(): void {
  try {
    fs.rmSync(HANDOFF_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Read and consume (delete) a fresh hand-off targeting one of this window's folders.
 * Returns the instruction, or undefined when there's nothing for us. Single-use: the
 * file is always deleted when it matches, so it can't replay.
 */
export function consumeHandoff(cwds: string[], now: number): Handoff | undefined {
  let h: Handoff;
  try {
    h = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
  } catch {
    return undefined; // no hand-off waiting
  }
  if (!h || typeof h.cwd !== 'string' || typeof h.ts !== 'number') {
    return undefined;
  }
  if (now - h.ts > FRESH_MS) {
    remove(); // stale — clean it up
    return undefined;
  }
  if (!cwds.some((c) => samePath(c, h.cwd))) {
    return undefined; // meant for a different window; leave it for them
  }
  remove(); // single-use
  return h;
}

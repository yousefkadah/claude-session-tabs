import { execFile } from 'child_process';
import * as path from 'path';

/** One working tree of a repo (the main checkout or a `git worktree add` sibling). */
export interface Worktree {
  /** Absolute working-directory path. */
  path: string;
  /** Short branch name ("main", "feat-a"), or "(detached)" when on a detached HEAD. */
  branch: string;
  /** Short HEAD sha (for the tooltip); empty for a fresh/bare tree. */
  head: string;
  detached: boolean;
  /** True for the repo's bare entry, which has no working directory to open. */
  bare: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`. Never rejects — returns a non-zero code instead, so callers can branch. */
function git(cwd: string, args: string[], timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * List every worktree of the repo containing `cwd`. Empty array when `cwd` isn't a
 * git repo or git is unavailable — callers degrade gracefully.
 */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const { code, stdout } = await git(cwd, ['worktree', 'list', '--porcelain']);
  if (code !== 0) {
    return [];
  }
  return parseWorktrees(stdout);
}

/** Parse `git worktree list --porcelain` output. Exported for testing. */
export function parseWorktrees(stdout: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Partial<Worktree> | undefined;
  const flush = (): void => {
    if (cur?.path) {
      out.push({
        path: cur.path,
        branch: cur.branch ?? (cur.detached ? '(detached)' : '(no branch)'),
        head: cur.head ?? '',
        detached: cur.detached ?? false,
        bare: cur.bare ?? false,
      });
    }
    cur = undefined;
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length) };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).slice(0, 8);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    }
  }
  flush();
  return out;
}

/**
 * The repo's shared git common dir (identical across all its worktrees) — used to
 * confirm two working dirs belong to the same repo and to name it. Undefined when
 * `cwd` isn't a git repo.
 */
export async function gitCommonDir(cwd: string): Promise<string | undefined> {
  const { code, stdout } = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (code !== 0) {
    return undefined;
  }
  const dir = stdout.trim();
  return dir || undefined;
}

/** A friendly repo name from its common dir (the parent folder of `.git`). */
export function repoNameFromCommonDir(commonDir: string): string {
  // commonDir is usually ".../<repo>/.git"; its parent's basename is the repo name.
  const parent = path.dirname(commonDir.replace(/\/\.git\/?$/, '/.git'));
  const name = path.basename(parent);
  return name || path.basename(commonDir);
}

/** True when `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const { code, stdout } = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return code === 0 && stdout.trim() === 'true';
}

export interface AddWorktreeResult {
  ok: boolean;
  /** git's stderr on failure, for surfacing to the user. */
  error?: string;
}

/**
 * Create a worktree at `dest` on `branch`. When `createBranch` is true a new branch
 * is created (`git worktree add -b`); otherwise an existing branch is checked out.
 */
export async function addWorktree(
  cwd: string,
  dest: string,
  branch: string,
  createBranch: boolean,
): Promise<AddWorktreeResult> {
  const args = createBranch
    ? ['worktree', 'add', '-b', branch, dest]
    : ['worktree', 'add', dest, branch];
  const { code, stderr } = await git(cwd, args, 30000);
  return code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `git exited ${code}` };
}

/** Local branch names in the repo (for the new-worktree picker). */
export async function listBranches(cwd: string): Promise<string[]> {
  const { code, stdout } = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (code !== 0) {
    return [];
  }
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

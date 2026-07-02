import * as fs from 'fs/promises';
import * as path from 'path';
import { SessionMeta } from '../model/types';

// Read whole file below this size; sample head+tail above it.
const FULL_LIMIT = 3_000_000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;

interface Acc {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  summary?: string;
  firstPrompt?: string;
  lastUserText?: string;
  lastAssistantText?: string;
  gitBranch?: string;
  cwd?: string;
  messageCount: number;
  contextTokens: number;
  outputTokens: number;
  sidechain: boolean;
}

/**
 * Parse a Claude Code transcript into display metadata. Returns null for
 * subagent (sidechain) transcripts, which are excluded from the session list.
 */
export async function parseSession(
  filePath: string,
  size: number,
  mtimeMs: number,
): Promise<SessionMeta | null> {
  const id = path.basename(filePath, '.jsonl');
  const acc: Acc = { messageCount: 0, contextTokens: 0, outputTokens: 0, sidechain: false };
  let approx = false;

  if (size <= FULL_LIMIT) {
    const text = await fs.readFile(filePath, 'utf8');
    processLines(text.split('\n'), acc);
  } else {
    approx = true;
    const fh = await fs.open(filePath, 'r');
    try {
      const headBuf = Buffer.alloc(HEAD_BYTES);
      await fh.read(headBuf, 0, HEAD_BYTES, 0);
      const tailBuf = Buffer.alloc(TAIL_BYTES);
      await fh.read(tailBuf, 0, TAIL_BYTES, Math.max(0, size - TAIL_BYTES));
      // Drop the trailing partial line of head and the leading partial line of tail.
      processLines(headBuf.toString('utf8').split('\n').slice(0, -1), acc);
      processLines(tailBuf.toString('utf8').split('\n').slice(1), acc);
    } finally {
      await fh.close();
    }
  }

  if (acc.sidechain) {
    return null;
  }

  const title =
    acc.customTitle || acc.aiTitle || acc.lastPrompt || acc.summary || acc.firstPrompt || 'Claude Code';

  return {
    id,
    filePath,
    title,
    customTitle: acc.customTitle,
    aiTitle: acc.aiTitle,
    lastPrompt: acc.lastPrompt,
    firstPrompt: acc.firstPrompt,
    lastUserText: acc.lastUserText,
    lastAssistantText: acc.lastAssistantText,
    gitBranch: acc.gitBranch,
    cwd: acc.cwd,
    mtimeMs,
    messageCount: acc.messageCount,
    contextTokens: acc.contextTokens,
    outputTokens: acc.outputTokens,
    approx,
  };
}

/**
 * Read the head of a transcript and return the first `cwd` found on any record.
 * Transcripts commonly begin with queue-operation / ai-title / summary lines that
 * carry no cwd, so scanning only the first line is unreliable.
 */
export async function readCwd(filePath: string): Promise<string | undefined> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s) {
        continue;
      }
      try {
        const r = JSON.parse(s);
        if (r && typeof r.cwd === 'string') {
          return r.cwd;
        }
      } catch {
        // Partial trailing line or non-JSON — keep scanning.
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

type RawRecord = Record<string, unknown> & {
  message?: { content?: unknown; usage?: Record<string, unknown> };
};

function processLines(lines: string[], acc: Acc): void {
  for (const line of lines) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    let r: RawRecord;
    try {
      r = JSON.parse(s);
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object') {
      continue;
    }
    if (r.isSidechain === true) {
      acc.sidechain = true;
    }
    if (typeof r.gitBranch === 'string') {
      acc.gitBranch = r.gitBranch;
    }
    if (typeof r.cwd === 'string') {
      acc.cwd = r.cwd;
    }
    switch (r.type) {
      case 'custom-title':
        if (typeof r.customTitle === 'string') {
          acc.customTitle = r.customTitle;
        }
        break;
      case 'ai-title':
        if (typeof r.aiTitle === 'string') {
          acc.aiTitle = r.aiTitle;
        }
        break;
      case 'last-prompt':
        if (typeof r.lastPrompt === 'string') {
          acc.lastPrompt = r.lastPrompt;
        }
        break;
      case 'summary':
        if (typeof r.summary === 'string') {
          acc.summary = r.summary;
        }
        break;
      case 'user': {
        const t = extractText(r.message?.content);
        if (t) {
          if (!acc.firstPrompt) {
            acc.firstPrompt = t;
          }
          acc.lastUserText = t;
          acc.messageCount++;
        }
        break;
      }
      case 'assistant': {
        acc.messageCount++;
        const t = extractText(r.message?.content);
        if (t) {
          acc.lastAssistantText = t;
        }
        const u = r.message?.usage;
        if (u) {
          acc.outputTokens += num(u.output_tokens);
          acc.contextTokens =
            num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
        }
        break;
      }
      default:
        break;
    }
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Pull only human-visible text out of a message's content (skips thinking, tool calls, images). */
function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (!b) {
        continue;
      }
      if (typeof b === 'string') {
        parts.push(b);
      } else if (typeof b === 'object' && (b as { type?: string }).type === 'text') {
        const text = (b as { text?: unknown }).text;
        if (typeof text === 'string') {
          parts.push(text);
        }
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

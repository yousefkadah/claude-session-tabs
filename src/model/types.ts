import type * as vscode from 'vscode';

/** Parsed metadata for one Claude Code session transcript (.jsonl). */
export interface SessionMeta {
  /** Session UUID (transcript filename without .jsonl), or a synthetic id for a brand-new tab. */
  id: string;
  /** Absolute path to the transcript file. Empty for synthetic (unmatched live) tabs. */
  filePath: string;
  /** Resolved display title (customTitle > aiTitle > lastPrompt > summary > firstPrompt). */
  title: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  firstPrompt?: string;
  lastUserText?: string;
  lastAssistantText?: string;
  gitBranch?: string;
  cwd?: string;
  /** Role of the last user/assistant message — 'assistant' means it's your turn. */
  lastRole?: 'user' | 'assistant';
  /** File modification time in ms since epoch. */
  mtimeMs: number;
  messageCount: number;
  /** Approx current context size from the last assistant usage record. */
  contextTokens: number;
  outputTokens: number;
  /** True when only the head/tail of a very large file was parsed. */
  approx: boolean;
}

/** A currently-open Claude Code webview tab, as seen through the Tab API. */
export interface LiveTab {
  label: string;
  viewColumn: vscode.ViewColumn | undefined;
  isActive: boolean;
  isDirty: boolean;
  isPinned: boolean;
  tab: vscode.Tab;
}

/** A session paired with its live-tab state and user organization. */
export interface SessionEntry {
  meta: SessionMeta;
  open: boolean;
  live?: LiveTab;
  pinned: boolean;
  /** User-marked "needs my attention" flag. */
  flagged: boolean;
  groupId: string | null;
}

/** A user-defined, named + colored group (Chrome-style). */
export interface GroupDef {
  id: string;
  name: string;
  /** ThemeColor id, e.g. "charts.blue". */
  color: string;
  collapsed: boolean;
}

/** Everything persisted per-workspace. */
export interface PersistedState {
  groups: GroupDef[];
  /** sessionId -> groupId */
  assignments: Record<string, string>;
  pinned: string[];
  /** session ids the user flagged as needing attention */
  flagged: string[];
  version: number;
}

// --- Serializable DTOs posted to the webview strip ---

export type SessionStatus = 'active' | 'open' | 'closed';

export interface StripSession {
  id: string;
  title: string;
  short: string;
  open: boolean;
  pinned: boolean;
  flagged: boolean;
  hasFile: boolean;
  status: SessionStatus;
  branch?: string;
  tokens?: string;
  rel: string;
  lastUser?: string;
  lastAssistant?: string;
}

export interface StripGroupRef {
  id: string;
  name: string;
  colorVar: string | null;
}

export interface StripGroup {
  /** null identifies the implicit "Ungrouped" bucket. */
  id: string | null;
  name: string;
  colorVar: string | null;
  sessions: StripSession[];
}

export interface StripData {
  groups: StripGroup[];
  allGroups: StripGroupRef[];
}

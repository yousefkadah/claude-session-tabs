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
  /** The last turn was Claude asking the user (AskUserQuestion / ExitPlanMode), unanswered. */
  pendingAsk: boolean;
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

/** A subagent Claude spawned within a session (from the session's sidecar dir). */
export interface SubagentInfo {
  agentId: string;
  agentType: string;
  description: string;
  /** Absolute path to the subagent's transcript (agent-<id>.jsonl). */
  filePath: string;
  /** Last activity of the subagent's transcript (ms). "running" is derived from this at render time. */
  mtimeMs: number;
}

/** A session paired with its live-tab state and user organization. */
export interface SessionEntry {
  meta: SessionMeta;
  open: boolean;
  live?: LiveTab;
  pinned: boolean;
  groupId: string | null;
  subagents: SubagentInfo[];
  /**
   * Marker-file mtime (ms) if a Claude Code hook flagged this session as needing
   * you (a real-time, lag-free signal); undefined when no marker is present.
   */
  attentionMtime?: number;
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
  /**
   * Group keys whose closed/inactive sessions are revealed. A key is a group id, or
   * '__ungrouped__' for the implicit Ungrouped bucket. Absent = default (hidden).
   */
  showInactive?: string[];
  /** When true the tree buckets sessions by git branch instead of user groups. */
  groupByBranch?: boolean;
  version: number;
}

// --- Serializable DTOs posted to the webview strip ---

export type SessionStatus = 'active' | 'needs-action' | 'open' | 'closed';

export interface StripSession {
  id: string;
  title: string;
  short: string;
  open: boolean;
  pinned: boolean;
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
  /** Whether this group is currently revealing its closed/inactive sessions. */
  showingInactive: boolean;
  /** How many closed sessions are hidden by the "show active only" default. */
  hidden: number;
  sessions: StripSession[];
}

export interface StripData {
  groups: StripGroup[];
  allGroups: StripGroupRef[];
}

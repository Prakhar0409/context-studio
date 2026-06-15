// Shared types for context-studio.
//
// These model the *normalized* view of a Claude Code session transcript.
// The raw on-disk format is JSONL where each line is a record; user/assistant
// records form a tree via `uuid`/`parentUuid`. We linearize the active leaf->root
// chain and normalize each message into the shapes below.

/** A single content block inside a message (one of Claude's block types). */
export type BlockKind =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "image"
  | "unknown";

export interface ContentBlock {
  kind: BlockKind;
  /** Human-readable preview text (truncated for transport; full text kept server-side). */
  preview: string;
  /** Approximate token count for this block (local tokenizer; not Claude-exact). */
  approxTokens: number;
  /** For tool_use/tool_result: the tool name, if known. */
  toolName?: string;
  /** Character length of the underlying text/serialized content. */
  chars: number;
}

export type Role = "user" | "assistant" | "system";

/** A normalized message: one user or assistant turn record from the transcript. */
export interface Message {
  uuid: string;
  parentUuid: string | null;
  role: Role;
  blocks: ContentBlock[];
  approxTokens: number;
  /** True if this message is a slash-command / local-command scaffold, not real user intent. */
  isMeta: boolean;
  /** Original line index in the JSONL file (for later editing). */
  lineIndex: number;
}

/**
 * A turn-group: a contiguous span of messages starting at a real user prompt
 * and running up to (but not including) the next real user prompt. This is the
 * unit the user will eventually drop or summarize.
 */
export interface TurnGroup {
  id: string;
  /** Mechanical title (first user prompt, truncated). */
  title: string;
  /** Optional LLM-generated theme label, e.g. "Decision: pick TS stack". */
  label?: string;
  messageUuids: string[];
  approxTokens: number;
  /** Share of total context tokens, 0..1. */
  tokenShare: number;
}

export interface SessionSummary {
  /** Encoded project dir name under ~/.claude/projects. */
  project: string;
  sessionId: string;
  filePath: string;
  /** Best-effort decoded working directory. */
  cwd: string;
  sizeBytes: number;
  mtimeMs: number;
  messageCount: number;
  approxTokens: number;
  title?: string;
}

// ---------------------------------------------------------------------------
// Edit operations (v2). Applied to a session to produce a pruned clone.
// ---------------------------------------------------------------------------

/** Remove an entire turn-group (all its messages) from the context. */
export interface DropGroupOp {
  kind: "dropGroup";
  groupId: string;
}

/** Remove or stub a single block inside one message. */
export interface DropBlockOp {
  kind: "dropBlock";
  messageUuid: string;
  /** Index of the block within the message's content array. */
  blockIndex: number;
  /** If provided, replace the block's text with this stub instead of removing it. */
  stub?: string;
}

/** Replace a contiguous span of messages with one synthetic summary turn. */
export interface SummarizeSpanOp {
  kind: "summarizeSpan";
  /** Message UUIDs to replace, in order. */
  messageUuids: string[];
  /** Pre-written summary text; if absent, server generates it via LLM. */
  summary?: string;
}

/** Replace a single text block's content with hand-edited text. */
export interface EditTextOp {
  kind: "editText";
  messageUuid: string;
  blockIndex: number;
  text: string;
}

export type EditOp = DropGroupOp | DropBlockOp | SummarizeSpanOp | EditTextOp;

export interface EditRequest {
  ops: EditOp[];
}

export interface EditResult {
  newSessionId: string;
  newFilePath: string;
  resumeCommand: string;
  /** Token totals before/after, approximate. */
  beforeApproxTokens: number;
  afterApproxTokens: number;
  removedMessages: number;
}

export interface ParsedSession {
  summary: SessionSummary;
  messages: Message[];
  groups: TurnGroup[];
  /** Sum of approxTokens across the active chain. */
  totalApproxTokens: number;
  /** Whether token counts are approximate (local tokenizer). Always true in v1. */
  tokensApproximate: boolean;
}

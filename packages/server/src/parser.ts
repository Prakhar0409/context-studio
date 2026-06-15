// Parse a Claude Code session JSONL transcript into a normalized ParsedSession.
//
// On-disk format (verified by inspecting real transcripts):
//   - One JSON object per line.
//   - Bookkeeping records: { type: "mode" | "permission-mode" |
//       "file-history-snapshot" | "attachment" | "last-prompt" | "ai-title" }.
//   - Conversation records: { type: "user" | "assistant", uuid, parentUuid,
//       message: { role, content } }.
//   - `content` is either a string (early user records / slash commands) or an
//       array of typed blocks: text | thinking | tool_use | tool_result | image.
//   - user/assistant records form a tree via uuid/parentUuid. The "active
//       context" is the chain from the latest leaf back to the root.
//
// We linearize that active chain and normalize each record into shared types.

import type {
  BlockKind,
  ContentBlock,
  Message,
  ParsedSession,
  Role,
  SessionSummary,
} from "@context-studio/shared";
import { approxTokens } from "./tokens.js";
import { buildGroups } from "./grouping.js";

interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
}

const PREVIEW_CHARS = 280;

/** Detect slash-command / local-command scaffolding so we can flag it as meta. */
function isMetaText(text: string): boolean {
  return (
    text.includes("<command-name>") ||
    text.includes("<local-command-stdout>") ||
    text.includes("<local-command-caveat>")
  );
}

function normalizeBlock(raw: unknown): ContentBlock {
  if (typeof raw === "string") {
    return {
      kind: "text",
      preview: raw.slice(0, PREVIEW_CHARS),
      approxTokens: approxTokens(raw),
      chars: raw.length,
    };
  }
  const b = (raw ?? {}) as Record<string, unknown>;
  const t = String(b.type ?? "unknown");

  switch (t) {
    case "text": {
      const text = String(b.text ?? "");
      return { kind: "text", preview: text.slice(0, PREVIEW_CHARS), approxTokens: approxTokens(text), chars: text.length };
    }
    case "thinking": {
      const text = String(b.thinking ?? "");
      return { kind: "thinking", preview: text.slice(0, PREVIEW_CHARS), approxTokens: approxTokens(text), chars: text.length };
    }
    case "tool_use": {
      const name = String(b.name ?? "");
      const input = JSON.stringify(b.input ?? {});
      const text = `${name} ${input}`;
      return { kind: "tool_use", toolName: name, preview: text.slice(0, PREVIEW_CHARS), approxTokens: approxTokens(text), chars: text.length };
    }
    case "tool_result": {
      const content = b.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content
          .map((c) => (typeof c === "string" ? c : typeof (c as any)?.text === "string" ? (c as any).text : ""))
          .join("\n");
      }
      return { kind: "tool_result", preview: text.slice(0, PREVIEW_CHARS), approxTokens: approxTokens(text), chars: text.length };
    }
    case "image":
      return { kind: "image", preview: "[image]", approxTokens: 0, chars: 0 };
    default:
      return { kind: "unknown" as BlockKind, preview: `[${t}]`, approxTokens: 0, chars: 0 };
  }
}

function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [normalizeBlock(content)];
  if (Array.isArray(content)) return content.map(normalizeBlock);
  return [];
}

/**
 * Build the active conversation chain.
 *
 * Empirically, a Claude Code transcript is NOT a single tree walkable from one
 * leaf: parentUuid links reset at segment boundaries (compaction / resume), so a
 * real session is a *forest* of linear chains in file order, with no branch
 * points. Branch points (edited/retried turns) are rare; when present, the
 * later record in file order is the surviving one.
 *
 * So the faithful, robust linearization is simply: conversation records in file
 * order, excluding sub-agent sidechains (isSidechain === true), and dropping any
 * record whose uuid is a non-final parent that was superseded by a sibling.
 */
function activeChain(records: { rec: RawRecord; line: number }[]): { rec: RawRecord; line: number }[] {
  const convo = records.filter(
    (r) =>
      (r.rec.type === "user" || r.rec.type === "assistant") &&
      r.rec.uuid &&
      r.rec.isSidechain !== true
  );

  // Detect branch points: a parentUuid claimed by more than one child. Keep only
  // the last child (latest in file order) for each parent — that is the surviving
  // branch after an edit/retry. With no branches this is a no-op.
  const childrenByParent = new Map<string, number[]>(); // parentUuid -> indices
  convo.forEach((r, i) => {
    const p = r.rec.parentUuid;
    if (!p) return;
    const arr = childrenByParent.get(p) ?? [];
    arr.push(i);
    childrenByParent.set(p, arr);
  });
  const superseded = new Set<number>();
  for (const indices of childrenByParent.values()) {
    if (indices.length > 1) {
      // All but the last child (and their descendants) are superseded.
      indices.slice(0, -1).forEach((i) => superseded.add(i));
    }
  }

  return convo.filter((_, i) => !superseded.has(i));
}

export function parseTranscript(
  text: string,
  summary: SessionSummary
): ParsedSession {
  const records: { rec: RawRecord; line: number }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push({ rec: JSON.parse(line) as RawRecord, line: i });
    } catch {
      /* skip malformed line */
    }
  }

  const chain = activeChain(records);

  const messages: Message[] = chain.map(({ rec, line }) => {
    const role = (rec.message?.role as Role) ?? "user";
    const blocks = normalizeContent(rec.message?.content);
    const approx = blocks.reduce((s, b) => s + b.approxTokens, 0);
    const metaText = blocks.some((b) => b.kind === "text" && isMetaText(b.preview));
    return {
      uuid: rec.uuid!,
      parentUuid: rec.parentUuid ?? null,
      role,
      blocks,
      approxTokens: approx,
      isMeta: metaText,
      lineIndex: line,
    };
  });

  const totalApproxTokens = messages.reduce((s, m) => s + m.approxTokens, 0);
  const groups = buildGroups(messages, totalApproxTokens);

  return {
    summary: { ...summary, messageCount: messages.length, approxTokens: totalApproxTokens },
    messages,
    groups,
    totalApproxTokens,
    tokensApproximate: true,
  };
}

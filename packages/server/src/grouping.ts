// Mechanical turn-grouping.
//
// A turn-group starts at a *real* user prompt (role=user, not meta, contains a
// text block — i.e. not a pure tool_result carrier) and runs up to but not
// including the next real user prompt. Assistant turns and the tool_result
// user-records that belong to a turn are folded into the preceding group.

import type { Message, TurnGroup } from "@context-studio/shared";

function isRealUserPrompt(m: Message): boolean {
  if (m.role !== "user" || m.isMeta) return false;
  // A genuine prompt has at least one text block and no tool_result blocks.
  const hasText = m.blocks.some((b) => b.kind === "text" && b.chars > 0);
  const isToolCarrier = m.blocks.some((b) => b.kind === "tool_result");
  return hasText && !isToolCarrier;
}

function titleFrom(m: Message): string {
  const text = m.blocks.find((b) => b.kind === "text")?.preview ?? "(turn)";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? clean.slice(0, 80) + "…" : clean || "(turn)";
}

export function buildGroups(messages: Message[], totalTokens: number): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  let idx = 0;

  for (const m of messages) {
    if (isRealUserPrompt(m) || current === null) {
      current = {
        id: `g${idx++}`,
        title: isRealUserPrompt(m) ? titleFrom(m) : "session setup",
        messageUuids: [],
        approxTokens: 0,
        tokenShare: 0,
      };
      groups.push(current);
    }
    current.messageUuids.push(m.uuid);
    current.approxTokens += m.approxTokens;
  }

  const denom = totalTokens || 1;
  for (const g of groups) g.tokenShare = g.approxTokens / denom;
  return groups;
}

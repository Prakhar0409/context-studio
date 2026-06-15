// Optional LLM topic-labeling of turn-groups.
//
// Given the parsed groups (with their first-user-prompt titles), ask Claude to
// produce a short thematic label per group, e.g. "Decision: choose TS stack".
// If ANTHROPIC_API_KEY is not set, this is a no-op and groups keep their
// mechanical titles. Uses the cheap Haiku model.

import type { ParsedSession, TurnGroup } from "@context-studio/shared";

const MODEL = "claude-haiku-4-5-20251001";

export function labelingAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Summarize a span of conversation into a compact "decisions + justification"
 * note that replaces it in the pruned context. Falls back to a mechanical stub
 * if no API key is configured.
 */
export async function summarizeSpan(spanText: string): Promise<string> {
  if (!labelingAvailable()) {
    return `[context-studio: summary of pruned span — set ANTHROPIC_API_KEY to auto-generate. Raw length ~${spanText.length} chars.]`;
  }
  const prompt = `The following is an excerpt from a coding-agent conversation that is being pruned from the context window to save tokens. Write a compact replacement note that preserves what future turns need: the decisions reached and their justification, key facts established, and any open threads. Be terse. Start with "Summary of earlier discussion:".

Excerpt:
${spanText.slice(0, 24000)}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return `[context-studio: summary failed (HTTP ${res.status})]`;
    const data: any = await res.json();
    const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
    return textBlock?.text ?? "[context-studio: empty summary]";
  } catch (e) {
    return `[context-studio: summary error: ${String(e)}]`;
  }
}

export async function labelGroups(session: ParsedSession): Promise<TurnGroup[]> {
  if (!labelingAvailable()) return session.groups;

  // Build a compact digest: index + title + token share per group.
  const digest = session.groups
    .map((g, i) => `${i}. (${Math.round(g.tokenShare * 100)}% ctx) ${g.title}`)
    .join("\n");

  const prompt = `You are labeling segments of a coding-agent conversation so a user can decide what to prune from the context window.
For each numbered segment below, output a concise thematic label (<= 6 words). Prefer the form "Topic: detail" and use "Decision:" when the segment settles a choice.
Return ONLY a JSON array of strings, one per segment, in order.

Segments:
${digest}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return session.groups;
    const data: any = await res.json();
    const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
    const raw = textBlock?.text ?? "[]";
    const match = raw.match(/\[[\s\S]*\]/);
    const labels: string[] = JSON.parse(match ? match[0] : raw);
    return session.groups.map((g, i) => ({ ...g, label: labels[i] ?? undefined }));
  } catch {
    return session.groups;
  }
}

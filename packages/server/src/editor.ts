// Context surgery: apply edit operations to a session and write a pruned clone.
//
// Design (non-destructive "new-session clone"):
//   - Re-read the ORIGINAL transcript's raw records (preserving every field).
//   - Apply ops over the conversation records (user/assistant), keyed by uuid.
//   - Repair the parentUuid chain so surviving records form one unbroken line.
//   - Stamp every record with a fresh sessionId and write to a NEW <newId>.jsonl
//     in the same project dir. The original file is never modified.
//   - Resume with:  claude --resume <newId>   (run from the original cwd)
//
// Why raw records, not the normalized Message form: the clone must preserve
// timestamps, version, gitBranch, promptId, etc. so the harness resumes cleanly.
// We only ever rewrite `uuid`/`parentUuid`/`sessionId` and (for edits) `content`.

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { EditOp, EditResult, ParsedSession } from "@context-studio/shared";
import { approxTokens } from "./tokens.js";
import { summarizeSpan } from "./labeler.js";

interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  sessionId?: string;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
}

/** Approx tokens of a single raw conversation record. */
function recordTokens(rec: RawRecord): number {
  const c = rec.message?.content;
  if (typeof c === "string") return approxTokens(c);
  if (!Array.isArray(c)) return 0;
  let t = 0;
  for (const b of c as any[]) {
    if (typeof b?.text === "string") t += approxTokens(b.text);
    else if (typeof b?.thinking === "string") t += approxTokens(b.thinking);
    else if (b?.type === "tool_use") t += approxTokens(String(b.name ?? "") + JSON.stringify(b.input ?? {}));
    else if (b?.type === "tool_result") {
      const cc = b.content;
      if (typeof cc === "string") t += approxTokens(cc);
      else if (Array.isArray(cc)) t += approxTokens(cc.map((x: any) => x?.text ?? "").join("\n"));
    }
  }
  return t;
}

function sumTokens(recs: RawRecord[]): number {
  return recs.reduce((s, r) => s + recordTokens(r), 0);
}

/**
 * Apply edits and write a pruned clone. `parsed` provides group->message mapping;
 * `originalText` is the raw transcript so we can preserve non-conversation records
 * (mode, file-history-snapshot, etc.) and all original fields.
 */
export async function applyEdits(
  parsed: ParsedSession,
  originalText: string,
  ops: EditOp[]
): Promise<EditResult> {
  // Parse raw lines, tagging conversation records.
  const allLines: { raw: RawRecord; isConvo: boolean }[] = [];
  for (const line of originalText.split("\n")) {
    if (!line.trim()) continue;
    let o: RawRecord;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const isConvo = (o.type === "user" || o.type === "assistant") && !!o.uuid && o.isSidechain !== true;
    allLines.push({ raw: o, isConvo });
  }

  // Conversation records in file order = the active chain (per parser's findings).
  let convo = allLines.filter((l) => l.isConvo).map((l) => l.raw);
  const beforeApproxTokens = sumTokens(convo);
  const originalCount = convo.length;

  // Resolve which uuids each op targets.
  const groupByUuid = new Map<string, string>(); // uuid -> groupId
  for (const g of parsed.groups) for (const u of g.messageUuids) groupByUuid.set(u, g.id);

  const dropUuids = new Set<string>();
  const blockEdits = new Map<string, { drop: Set<number>; stub: Map<number, string>; text: Map<number, string> }>();

  function blockEdit(uuid: string) {
    let e = blockEdits.get(uuid);
    if (!e) {
      e = { drop: new Set(), stub: new Map(), text: new Map() };
      blockEdits.set(uuid, e);
    }
    return e;
  }

  // Summaries: span uuids -> synthetic replacement records (built below).
  const summaryOps: { uuids: string[]; summary: string }[] = [];

  for (const op of ops) {
    switch (op.kind) {
      case "dropGroup": {
        const g = parsed.groups.find((x) => x.id === op.groupId);
        if (g) g.messageUuids.forEach((u) => dropUuids.add(u));
        break;
      }
      case "dropBlock": {
        const e = blockEdit(op.messageUuid);
        if (op.stub != null) e.stub.set(op.blockIndex, op.stub);
        else e.drop.add(op.blockIndex);
        break;
      }
      case "editText": {
        blockEdit(op.messageUuid).text.set(op.blockIndex, op.text);
        break;
      }
      case "summarizeSpan": {
        const summary =
          op.summary ?? (await summarizeSpan(spanText(convo, op.messageUuids)));
        summaryOps.push({ uuids: op.messageUuids, summary });
        break;
      }
    }
  }

  // Apply block-level edits in place (mutating clones of the content arrays).
  for (const rec of convo) {
    const e = rec.uuid ? blockEdits.get(rec.uuid) : undefined;
    if (!e) continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    const next: any[] = [];
    content.forEach((b: any, i: number) => {
      if (e.drop.has(i)) return; // remove entirely
      if (e.text.has(i) && b?.type === "text") {
        next.push({ ...b, text: e.text.get(i) });
      } else if (e.stub.has(i)) {
        next.push(stubBlock(b, e.stub.get(i)!));
      } else {
        next.push(b);
      }
    });
    rec.message = { ...rec.message, content: next };
  }

  // Apply summaries: replace the FIRST uuid of each span with a synthetic
  // assistant record carrying the summary, and drop the rest of the span.
  for (const s of summaryOps) {
    const [first, ...rest] = s.uuids;
    rest.forEach((u) => dropUuids.add(u));
    const rec = convo.find((r) => r.uuid === first);
    if (rec) {
      rec.message = { role: "assistant", content: [{ type: "text", text: s.summary }] };
    }
  }

  // Drop removed records, then repair the parentUuid chain to a single line.
  convo = convo.filter((r) => !(r.uuid && dropUuids.has(r.uuid)));
  let prevUuid: string | null = null;
  for (const rec of convo) {
    rec.parentUuid = prevUuid;
    prevUuid = rec.uuid ?? prevUuid;
  }

  const afterApproxTokens = sumTokens(convo);

  // Rebuild the full file: keep non-conversation records in place, but substitute
  // the edited conversation records (and drop removed ones) in original order.
  const newSessionId = randomUUID();
  const keptConvo = new Set(convo.map((r) => r.uuid));
  const convoByUuid = new Map(convo.map((r) => [r.uuid, r]));

  const outLines: string[] = [];
  for (const { raw, isConvo } of allLines) {
    let rec = raw;
    if (isConvo) {
      if (!keptConvo.has(raw.uuid)) continue; // dropped
      rec = convoByUuid.get(raw.uuid)!; // edited version (parent rewritten)
    }
    // Stamp the new sessionId on every record that carries one.
    const stamped = "sessionId" in rec ? { ...rec, sessionId: newSessionId } : rec;
    outLines.push(JSON.stringify(stamped));
  }

  const projDir = dirname(parsed.summary.filePath);
  const newFilePath = join(projDir, `${newSessionId}.jsonl`);
  await writeFile(newFilePath, outLines.join("\n") + "\n", "utf8");

  return {
    newSessionId,
    newFilePath,
    resumeCommand: `cd ${parsed.summary.cwd} && claude --resume ${newSessionId}`,
    beforeApproxTokens,
    afterApproxTokens,
    removedMessages: originalCount - convo.length,
  };
}

/** Build a stub block preserving the original block's type where sensible. */
function stubBlock(b: any, stub: string): any {
  if (b?.type === "tool_result") {
    return { ...b, content: stub };
  }
  if (b?.type === "tool_use") {
    return { ...b, input: { pruned: stub } };
  }
  return { type: "text", text: stub };
}

/** Concatenate the text of a span of messages, for summarization input. */
function spanText(convo: RawRecord[], uuids: string[]): string {
  const set = new Set(uuids);
  const parts: string[] = [];
  for (const rec of convo) {
    if (!rec.uuid || !set.has(rec.uuid)) continue;
    const role = rec.message?.role ?? "?";
    const c = rec.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c))
      text = (c as any[])
        .map((b) => b?.text ?? b?.thinking ?? (b?.type === "tool_result" ? "[tool result]" : ""))
        .filter(Boolean)
        .join("\n");
    parts.push(`${role.toUpperCase()}: ${text}`);
  }
  return parts.join("\n\n");
}

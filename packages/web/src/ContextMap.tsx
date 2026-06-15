import { useMemo, useState } from "react";
import type {
  ContentBlock,
  EditOp,
  EditResult,
  Message,
  ParsedSession,
  TurnGroup,
} from "@context-studio/shared";
import { applyEdits } from "./api.js";

const BLOCK_COLORS: Record<string, string> = {
  text: "#4f8cff",
  thinking: "#9b8cff",
  tool_use: "#ff9f43",
  tool_result: "#22c1a4",
  image: "#e06bd6",
  unknown: "#8a93a6",
};

const GROUP_PALETTE = [
  "#4f8cff", "#22c1a4", "#ff9f43", "#9b8cff", "#e06bd6",
  "#f6c945", "#5ad1e0", "#ff6b6b", "#7ed957", "#c490ff",
];

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}
function groupLabel(g: TurnGroup): string {
  return g.label ?? g.title;
}

// ---- Pending-edit model (client-side; serialized to EditOp[] on save) --------

interface PendingEdits {
  droppedGroups: Set<string>;
  droppedBlocks: Set<string>; // `${uuid}:${index}`
  summarizedGroups: Set<string>;
  editedText: Map<string, string>; // `${uuid}:${index}` -> new text
}

function blockKey(uuid: string, i: number) {
  return `${uuid}:${i}`;
}

function toOps(p: PendingEdits, groups: TurnGroup[]): EditOp[] {
  const ops: EditOp[] = [];
  for (const gid of p.droppedGroups) ops.push({ kind: "dropGroup", groupId: gid });
  for (const gid of p.summarizedGroups) {
    const g = groups.find((x) => x.id === gid);
    if (g) ops.push({ kind: "summarizeSpan", messageUuids: g.messageUuids });
  }
  for (const key of p.droppedBlocks) {
    const [uuid, i] = key.split(":");
    ops.push({ kind: "dropBlock", messageUuid: uuid, blockIndex: Number(i) });
  }
  for (const [key, text] of p.editedText) {
    const [uuid, i] = key.split(":");
    ops.push({ kind: "editText", messageUuid: uuid, blockIndex: Number(i), text });
  }
  return ops;
}

// ---- Visualization pieces ----------------------------------------------------

function OverviewBar({
  groups,
  total,
  dropped,
  onPick,
}: {
  groups: TurnGroup[];
  total: number;
  dropped: Set<string>;
  onPick: (id: string) => void;
}) {
  return (
    <div className="overview">
      <div className="overviewBar">
        {groups.map((g, i) => (
          <div
            key={g.id}
            className={"overviewSeg" + (dropped.has(g.id) ? " droppedSeg" : "")}
            style={{ width: pct(g.approxTokens / (total || 1)), background: GROUP_PALETTE[i % GROUP_PALETTE.length] }}
            title={`${groupLabel(g)} — ${g.approxTokens.toLocaleString()} tok (${pct(g.tokenShare)})`}
            onClick={() => onPick(g.id)}
          >
            {g.tokenShare > 0.06 && <span className="overviewSegLabel">{pct(g.tokenShare)}</span>}
          </div>
        ))}
      </div>
      <div className="overviewScale">
        <span>0</span>
        <span>{total.toLocaleString()} approx tokens</span>
      </div>
    </div>
  );
}

function BlockBreakdown({ messages }: { messages: Message[] }) {
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const msg of messages)
      for (const b of msg.blocks) m.set(b.kind, (m.get(b.kind) ?? 0) + b.approxTokens);
    const sum = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    return [...m.entries()].map(([kind, tok]) => ({ kind, tok, share: tok / sum })).sort((a, b) => b.tok - a.tok);
  }, [messages]);

  return (
    <div className="breakdown">
      <div className="breakdownTitle">Tokens by block type</div>
      {totals.map((t) => (
        <div key={t.kind} className="breakdownRow">
          <span className="breakdownKind" style={{ background: BLOCK_COLORS[t.kind] ?? "#888" }}>{t.kind}</span>
          <div className="breakdownTrack">
            <div className="breakdownFill" style={{ width: pct(t.share), background: BLOCK_COLORS[t.kind] ?? "#888" }} />
          </div>
          <span className="breakdownTok">{t.tok.toLocaleString()}</span>
          <span className="breakdownShare">{pct(t.share)}</span>
        </div>
      ))}
    </div>
  );
}

function BlockRow({
  block,
  uuid,
  index,
  edit,
  pending,
  setPending,
}: {
  block: ContentBlock;
  uuid: string;
  index: number;
  edit: boolean;
  pending: PendingEdits;
  setPending: (p: PendingEdits) => void;
}) {
  const key = blockKey(uuid, index);
  const dropped = pending.droppedBlocks.has(key);
  const editedText = pending.editedText.get(key);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(editedText ?? block.preview);

  function toggleDrop() {
    const next = new Set(pending.droppedBlocks);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPending({ ...pending, droppedBlocks: next });
  }
  function saveEdit() {
    const m = new Map(pending.editedText);
    m.set(key, draft);
    setPending({ ...pending, editedText: m });
    setEditing(false);
  }

  return (
    <div className={"block" + (dropped ? " blockDropped" : "")}>
      <span className="blockKind" style={{ background: BLOCK_COLORS[block.kind] ?? "#888" }}>
        {block.kind}{block.toolName ? `:${block.toolName}` : ""}
      </span>
      <span className="blockTokens">{block.approxTokens.toLocaleString()} tok</span>
      {editing ? (
        <span className="blockEditArea">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} />
          <button className="miniBtn" onClick={saveEdit}>Save</button>
          <button className="miniBtn ghost" onClick={() => setEditing(false)}>Cancel</button>
        </span>
      ) : (
        <span className="blockPreview">{editedText ?? (block.preview || "—")}</span>
      )}
      {edit && !editing && (
        <span className="blockActions">
          {block.kind === "text" && (
            <button className="miniBtn ghost" onClick={() => { setDraft(editedText ?? block.preview); setEditing(true); }}>edit</button>
          )}
          <button className="miniBtn ghost" onClick={toggleDrop}>{dropped ? "undo" : "drop"}</button>
        </span>
      )}
    </div>
  );
}

function GroupCard({
  group,
  index,
  messages,
  maxTokens,
  open,
  onToggle,
  edit,
  pending,
  setPending,
}: {
  group: TurnGroup;
  index: number;
  messages: Map<string, Message>;
  maxTokens: number;
  open: boolean;
  onToggle: () => void;
  edit: boolean;
  pending: PendingEdits;
  setPending: (p: PendingEdits) => void;
}) {
  const color = GROUP_PALETTE[index % GROUP_PALETTE.length];
  const droppedGroup = pending.droppedGroups.has(group.id);
  const summarized = pending.summarizedGroups.has(group.id);

  function toggle(set: Set<string>, key: "droppedGroups" | "summarizedGroups") {
    const next = new Set(set);
    if (next.has(group.id)) next.delete(group.id);
    else next.add(group.id);
    return { ...pending, [key]: next };
  }

  return (
    <div className={"groupCard" + (droppedGroup ? " cardDropped" : "")} id={`group-${group.id}`}>
      <div className="groupHeader" onClick={onToggle}>
        <span className="groupDot" style={{ background: color }} />
        <span className="groupCaret">{open ? "▾" : "▸"}</span>
        <span className="groupTitle">
          {groupLabel(group)}
          {droppedGroup && <em className="tag drop"> dropped</em>}
          {summarized && <em className="tag sum"> summarize</em>}
        </span>
        <span className="groupShare">{pct(group.tokenShare)}</span>
        <span className="groupTokens">{group.approxTokens.toLocaleString()} tok</span>
      </div>
      <div className="groupBarTrack">
        <div className="groupBar" style={{ width: pct(group.approxTokens / (maxTokens || 1)), background: color }} />
      </div>
      {edit && (
        <div className="groupActions" onClick={(e) => e.stopPropagation()}>
          <button className="miniBtn" onClick={() => setPending(toggle(pending.droppedGroups, "droppedGroups"))}>
            {droppedGroup ? "Undo drop" : "Drop group"}
          </button>
          <button className="miniBtn" onClick={() => setPending(toggle(pending.summarizedGroups, "summarizedGroups"))}>
            {summarized ? "Undo summarize" : "Summarize → 1 turn"}
          </button>
        </div>
      )}
      {open && (
        <div className="groupBody">
          {group.messageUuids.map((uuid) => {
            const m = messages.get(uuid);
            if (!m) return null;
            return (
              <div key={uuid} className={`msg msg-${m.role}`}>
                <div className="msgRole">{m.role}{m.isMeta ? " · meta" : ""} · {m.approxTokens.toLocaleString()} tok</div>
                {m.blocks.map((b, i) => (
                  <BlockRow key={i} block={b} uuid={uuid} index={i} edit={edit} pending={pending} setPending={setPending} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Edit summary / save panel ----------------------------------------------

function projectedSavings(session: ParsedSession, pending: PendingEdits): number {
  const msgs = new Map(session.messages.map((m) => [m.uuid, m]));
  let saved = 0;
  for (const gid of pending.droppedGroups) {
    const g = session.groups.find((x) => x.id === gid);
    if (g) saved += g.approxTokens;
  }
  for (const gid of pending.summarizedGroups) {
    if (pending.droppedGroups.has(gid)) continue;
    const g = session.groups.find((x) => x.id === gid);
    if (g) saved += Math.max(0, g.approxTokens - 120); // summary ~120 tok
  }
  for (const key of pending.droppedBlocks) {
    const [uuid, i] = key.split(":");
    const b = msgs.get(uuid)?.blocks[Number(i)];
    if (b) saved += b.approxTokens;
  }
  return saved;
}

function EditPanel({
  session,
  pending,
  onClear,
  onSave,
  saving,
  result,
  error,
}: {
  session: ParsedSession;
  pending: PendingEdits;
  onClear: () => void;
  onSave: () => void;
  saving: boolean;
  result: EditResult | null;
  error: string | null;
}) {
  const opCount =
    pending.droppedGroups.size + pending.droppedBlocks.size + pending.summarizedGroups.size + pending.editedText.size;
  const saved = projectedSavings(session, pending);
  const after = Math.max(0, session.totalApproxTokens - saved);

  return (
    <div className="editPanel">
      <div className="editPanelHead">
        <strong>{opCount} edit{opCount === 1 ? "" : "s"} pending</strong>
        <span className="muted">
          {session.totalApproxTokens.toLocaleString()} → ~{after.toLocaleString()} tok
          {saved > 0 && <em className="savings"> (−{saved.toLocaleString()}, {pct(saved / (session.totalApproxTokens || 1))})</em>}
        </span>
      </div>
      <div className="editPanelActions">
        <button onClick={onSave} disabled={opCount === 0 || saving}>{saving ? "Saving clone…" : "Save pruned clone"}</button>
        <button className="ghost" onClick={onClear} disabled={opCount === 0 || saving}>Clear</button>
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="editResult">
          <div>✓ Wrote pruned clone (original untouched). New session <code>{result.newSessionId.slice(0, 8)}</code>.</div>
          <div className="muted">{result.removedMessages} messages removed · {result.beforeApproxTokens.toLocaleString()} → {result.afterApproxTokens.toLocaleString()} tok</div>
          <div className="resumeBox">Resume with:<br /><code>{result.resumeCommand}</code></div>
        </div>
      )}
    </div>
  );
}

// ---- Main --------------------------------------------------------------------

export function ContextMap({ session }: { session: ParsedSession }) {
  const messages = useMemo(() => new Map(session.messages.map((m) => [m.uuid, m])), [session]);
  const maxTokens = Math.max(...session.groups.map((g) => g.approxTokens), 1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [pending, setPending] = useState<PendingEdits>({
    droppedGroups: new Set(),
    droppedBlocks: new Set(),
    summarizedGroups: new Set(),
    editedText: new Map(),
  });
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<EditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function clearPending() {
    setPending({ droppedGroups: new Set(), droppedBlocks: new Set(), summarizedGroups: new Set(), editedText: new Map() });
    setResult(null);
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const ops = toOps(pending, session.groups);
      setResult(await applyEdits(session.summary.project, session.summary.sessionId, ops));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }

  function pickGroup(id: string) {
    setOpenId(id);
    requestAnimationFrame(() => document.getElementById(`group-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div className="contextMap">
      <div className="mapToolbar">
        <button className={edit ? "toggleBtn active" : "toggleBtn"} onClick={() => setEdit((e) => !e)}>
          {edit ? "✎ Editing — exit" : "✎ Edit context"}
        </button>
      </div>

      <OverviewBar groups={session.groups} total={session.totalApproxTokens} dropped={pending.droppedGroups} onPick={pickGroup} />
      <BlockBreakdown messages={session.messages} />
      <div className="approxNote">
        Token counts are approximate (local cl100k tokenizer, not Claude-exact). Use for relative sizing.
      </div>

      {edit && (
        <EditPanel session={session} pending={pending} onClear={clearPending} onSave={save} saving={saving} result={result} error={error} />
      )}

      <div className="groupListTitle">Turn groups ({session.groups.length})</div>
      {session.groups.map((g, i) => (
        <GroupCard
          key={g.id}
          group={g}
          index={i}
          messages={messages}
          maxTokens={maxTokens}
          open={openId === g.id}
          onToggle={() => setOpenId((cur) => (cur === g.id ? null : g.id))}
          edit={edit}
          pending={pending}
          setPending={setPending}
        />
      ))}
    </div>
  );
}

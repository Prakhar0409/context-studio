import type { EditOp, EditResult, ParsedSession, SessionSummary } from "@context-studio/shared";

export async function fetchSessions(): Promise<SessionSummary[]> {
  const r = await fetch("/api/sessions");
  if (!r.ok) throw new Error(`sessions: ${r.status}`);
  return r.json();
}

export async function fetchSession(project: string, id: string): Promise<ParsedSession> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`session: ${r.status}`);
  return r.json();
}

export async function labelSession(project: string, id: string): Promise<ParsedSession> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}/label`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`label: ${r.status}`);
  return r.json();
}

export async function fetchHealth(): Promise<{ ok: boolean; labeling: boolean }> {
  const r = await fetch("/api/health");
  return r.json();
}

export interface SearchHit {
  project: string;
  sessionId: string;
  matchCount: number;
  snippet: string;
}

export async function searchSessions(q: string): Promise<SearchHit[]> {
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`search: ${r.status}`);
  return r.json();
}

export async function applyEdits(
  project: string,
  id: string,
  ops: EditOp[]
): Promise<EditResult> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(project)}/${encodeURIComponent(id)}/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error ?? `edit: ${r.status}`);
  }
  return r.json();
}

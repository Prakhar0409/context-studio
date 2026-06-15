import { useEffect, useState } from "react";
import type { ParsedSession, SessionSummary } from "@context-studio/shared";
import { fetchHealth, fetchSession, fetchSessions, labelSession } from "./api.js";
import { SessionPicker } from "./SessionPicker.js";
import { ContextMap } from "./ContextMap.js";

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [parsed, setParsed] = useState<ParsedSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [labeling, setLabeling] = useState(false);
  const [canLabel, setCanLabel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHealth().then((h) => setCanLabel(h.labeling)).catch(() => {});
    fetchSessions().then(setSessions).catch((e) => setError(String(e)));
  }, []);

  async function open(s: SessionSummary) {
    setSelected(s);
    setParsed(null);
    setLoading(true);
    setError(null);
    try {
      setParsed(await fetchSession(s.project, s.sessionId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runLabeling() {
    if (!selected) return;
    setLabeling(true);
    try {
      setParsed(await labelSession(selected.project, selected.sessionId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLabeling(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>context-studio</h1>
        <p className="tagline">visualize an agent's context window</p>
        <SessionPicker sessions={sessions} selected={selected} onSelect={open} />
      </aside>
      <main className="main">
        {error && <div className="error">{error}</div>}
        {!selected && <div className="empty">Pick a session to inspect its context.</div>}
        {loading && <div className="empty">Parsing transcript…</div>}
        {parsed && (
          <>
            <header className="mainHeader">
              <div>
                <h2>{parsed.summary.title ?? parsed.summary.sessionId}</h2>
                <div className="muted">
                  {parsed.summary.cwd} · {parsed.messages.length} messages ·{" "}
                  {parsed.totalApproxTokens.toLocaleString()} approx tokens
                </div>
              </div>
              <div className="labelControl">
                <button disabled={!canLabel || labeling} onClick={runLabeling}>
                  {labeling ? "Labeling…" : "Label topics (LLM)"}
                </button>
                {!canLabel && (
                  <span className="labelHint">
                    Set <code>ANTHROPIC_API_KEY</code> and restart the server to enable
                  </span>
                )}
              </div>
            </header>
            <ContextMap session={parsed} />
          </>
        )}
      </main>
    </div>
  );
}

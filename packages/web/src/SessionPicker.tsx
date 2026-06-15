import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@context-studio/shared";
import { searchSessions, type SearchHit } from "./api.js";

function kb(bytes: number): string {
  if (bytes > 1_048_576) return (bytes / 1_048_576).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

function displayTitle(s: SessionSummary): string {
  return s.title ?? s.sessionId.slice(0, 8);
}

/** Render a snippet with «term» markers turned into <mark>. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«([^»]*)»/);
  return (
    <div className="pickerSnippet">
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </div>
  );
}

export function SessionPicker({
  sessions,
  selected,
  onSelect,
}: {
  sessions: SessionSummary[];
  selected: SessionSummary | null;
  onSelect: (s: SessionSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"title" | "fulltext">("title");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Full-text search (debounced). Title mode filters client-side instantly.
  useEffect(() => {
    if (mode !== "fulltext") {
      setHits(null);
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setHits(null);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      try {
        setHits(await searchSessions(query));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, mode]);

  const byKey = new Map(sessions.map((s) => [s.project + "/" + s.sessionId, s]));

  // Decide which sessions to show.
  let visible: { s: SessionSummary; snippet?: string; matchCount?: number }[];
  if (mode === "fulltext" && hits) {
    visible = hits
      .map((h) => ({ s: byKey.get(h.project + "/" + h.sessionId), snippet: h.snippet, matchCount: h.matchCount }))
      .filter((x): x is { s: SessionSummary; snippet: string; matchCount: number } => !!x.s);
  } else {
    const q = query.trim().toLowerCase();
    visible = sessions
      .filter((s) => !q || displayTitle(s).toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
      .map((s) => ({ s }));
  }

  return (
    <div className="pickerWrap">
      <input
        className="searchBox"
        placeholder={mode === "title" ? "Filter by title…" : "Search inside chats…"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="searchModes">
        <button className={mode === "title" ? "modeBtn active" : "modeBtn"} onClick={() => setMode("title")}>
          Titles
        </button>
        <button className={mode === "fulltext" ? "modeBtn active" : "modeBtn"} onClick={() => setMode("fulltext")}>
          Full text
        </button>
        <span className="searchCount">
          {searching ? "searching…" : `${visible.length} ${visible.length === 1 ? "session" : "sessions"}`}
        </span>
      </div>
      <ul className="picker">
        {visible.map(({ s, snippet, matchCount }) => {
          const active = selected?.sessionId === s.sessionId && selected?.project === s.project;
          const shortCwd = s.cwd.split("/").slice(-2).join("/");
          return (
            <li
              key={s.project + "/" + s.sessionId}
              className={active ? "pickerItem active" : "pickerItem"}
              onClick={() => onSelect(s)}
            >
              <div className="pickerTitle">{displayTitle(s)}</div>
              <div className="pickerMeta">
                {shortCwd} · {kb(s.sizeBytes)}
                {matchCount ? ` · ${matchCount} match${matchCount === 1 ? "" : "es"}` : ""}
              </div>
              {snippet && <Snippet text={snippet} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

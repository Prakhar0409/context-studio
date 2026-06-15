// Discover Claude Code sessions on disk.
//
// Sessions live at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
// The encoded-cwd is the absolute working directory with "/" replaced by "-"
// (e.g. /Volumes/workplace/... -> -Volumes-workplace-...). We decode it
// best-effort for display.

import { readdir, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@context-studio/shared";

export function projectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** Best-effort decode of an encoded project dir name back to a path. */
function decodeCwd(encoded: string): string {
  // Leading "-" represents the root "/". Remaining "-" are path separators,
  // but real dir names may also contain "-", so this is approximate.
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}

/** Extract clean text from a record's message content (string or block array). */
function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const t = content.find((b: any) => b?.type === "text");
    return typeof t?.text === "string" ? t.text : "";
  }
  return "";
}

function looksMeta(text: string): boolean {
  return text.includes("<command-name>") || text.includes("<local-command");
}

/**
 * Derive a human-readable title: prefer the session's ai-title (field `aiTitle`),
 * otherwise the first genuine user prompt, otherwise undefined (caller shows id).
 */
async function quickTitle(filePath: string): Promise<string | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    let firstPrompt: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "ai-title") {
        const t = o.aiTitle ?? o.title;
        if (typeof t === "string" && t.trim()) return t.trim();
      }
      if (!firstPrompt && o.type === "user") {
        const t = firstText(o.message?.content).replace(/\s+/g, " ").trim();
        if (t && !looksMeta(t)) firstPrompt = t.length > 60 ? t.slice(0, 60) + "…" : t;
      }
    }
    return firstPrompt;
  } catch {
    return undefined;
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  const root = projectsRoot();
  const out: SessionSummary[] = [];

  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return out;
  }

  for (const project of projects) {
    const projDir = join(root, project);
    let entries: string[];
    try {
      const s = await stat(projDir);
      if (!s.isDirectory()) continue;
      entries = await readdir(projDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = join(projDir, entry);
      let st;
      try {
        st = await stat(filePath);
      } catch {
        continue;
      }
      out.push({
        project,
        sessionId: entry.replace(/\.jsonl$/, ""),
        filePath,
        cwd: decodeCwd(project),
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        messageCount: 0,
        approxTokens: 0,
        title: await quickTitle(filePath),
      });
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export function findSessionFile(
  sessions: SessionSummary[],
  project: string,
  sessionId: string
): SessionSummary | undefined {
  return sessions.find((s) => s.project === project && s.sessionId === sessionId);
}

export interface SearchHit {
  project: string;
  sessionId: string;
  /** Number of messages whose text matched. */
  matchCount: number;
  /** A short snippet around the first match, with the term highlighted by «». */
  snippet: string;
}

/**
 * Full-text search across all transcripts, on demand (no persistent index).
 *
 * Why no DB/index: at local scale (tens of sessions, MBs each) a direct scan is
 * fast and always fresh — a periodic index would add staleness and complexity for
 * no real win. If a user accumulates thousands of large sessions, revisit with a
 * SQLite FTS index keyed on file mtime. For now: read each file, scan user/assistant
 * text + tool content for the term, return per-session hit counts and a snippet.
 */
export async function searchSessions(query: string): Promise<SearchHit[]> {
  const term = query.trim().toLowerCase();
  if (!term) return [];

  const sessions = await listSessions();
  const hits: SearchHit[] = [];

  for (const s of sessions) {
    let text: string;
    try {
      text = await readFile(s.filePath, "utf8");
    } catch {
      continue;
    }

    let matchCount = 0;
    let snippet = "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "user" && o.type !== "assistant") continue;
      const content = o.message?.content;
      const flat = flattenForSearch(content);
      const idx = flat.toLowerCase().indexOf(term);
      if (idx === -1) continue;
      matchCount++;
      if (!snippet) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(flat.length, idx + term.length + 40);
        snippet =
          (start > 0 ? "…" : "") +
          flat.slice(start, idx) +
          "«" +
          flat.slice(idx, idx + term.length) +
          "»" +
          flat.slice(idx + term.length, end) +
          (end < flat.length ? "…" : "");
        snippet = snippet.replace(/\s+/g, " ").trim();
      }
    }

    if (matchCount > 0) hits.push({ project: s.project, sessionId: s.sessionId, matchCount, snippet });
  }

  hits.sort((a, b) => b.matchCount - a.matchCount);
  return hits;
}

/** Flatten a message's content (string or block array) into searchable text. */
function flattenForSearch(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as any[]) {
    if (!b || typeof b !== "object") continue;
    if (typeof b.text === "string") parts.push(b.text);
    if (typeof b.thinking === "string") parts.push(b.thinking);
    if (b.type === "tool_use" && b.name) parts.push(String(b.name) + " " + JSON.stringify(b.input ?? {}));
    if (b.type === "tool_result") {
      const c = b.content;
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c)) parts.push(c.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join(" "));
    }
  }
  return parts.join("\n");
}

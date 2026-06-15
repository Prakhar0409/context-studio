// context-studio API server.
//
// Endpoints:
//   GET  /api/health                          -> { ok, labeling }
//   GET  /api/sessions                        -> SessionSummary[]
//   GET  /api/sessions/:project/:id           -> ParsedSession
//   POST /api/sessions/:project/:id/label     -> ParsedSession (groups labeled)
//
// Read-only in v1. No transcript is ever modified.

import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import type { EditOp } from "@context-studio/shared";
import { listSessions, findSessionFile, searchSessions } from "./scanner.js";
import { parseTranscript } from "./parser.js";
import { labelGroups, labelingAvailable } from "./labeler.js";
import { applyEdits } from "./editor.js";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4317);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, labeling: labelingAvailable() });
});

app.get("/api/sessions", async (_req, res) => {
  try {
    res.json(await listSessions());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q ?? "");
    res.json(await searchSessions(q));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

async function loadParsed(project: string, id: string) {
  const sessions = await listSessions();
  const summary = findSessionFile(sessions, project, id);
  if (!summary) return null;
  const text = await readFile(summary.filePath, "utf8");
  return parseTranscript(text, summary);
}

app.get("/api/sessions/:project/:id", async (req, res) => {
  try {
    const parsed = await loadParsed(req.params.project, req.params.id);
    if (!parsed) return res.status(404).json({ error: "session not found" });
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/sessions/:project/:id/label", async (req, res) => {
  try {
    const parsed = await loadParsed(req.params.project, req.params.id);
    if (!parsed) return res.status(404).json({ error: "session not found" });
    parsed.groups = await labelGroups(parsed);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Apply edits and write a pruned clone (non-destructive). Original is untouched.
app.post("/api/sessions/:project/:id/edit", async (req, res) => {
  try {
    const parsed = await loadParsed(req.params.project, req.params.id);
    if (!parsed) return res.status(404).json({ error: "session not found" });
    const ops = (req.body?.ops ?? []) as EditOp[];
    if (!Array.isArray(ops) || ops.length === 0)
      return res.status(400).json({ error: "no ops provided" });
    const originalText = await readFile(parsed.summary.filePath, "utf8");
    const result = await applyEdits(parsed, originalText, ops);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`context-studio server on http://localhost:${PORT}  (labeling: ${labelingAvailable()})`);
});

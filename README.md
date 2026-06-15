# context-studio

Visualize an LLM coding-agent's context window — and (later) prune it.

A Claude Code session is stored on disk as a JSONL transcript at
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Each line is a record;
`user`/`assistant` records form a tree via `uuid` / `parentUuid`. The context the
model actually sees is the active leaf→root chain of that tree.

context-studio reads those transcripts and shows **where your tokens are going**:
turn-groups stacked by their share of the context, drill down into the individual
blocks (text / thinking / tool_use / tool_result / image) inside each group.

## Status

**v1 — visualize (read-only)**
- Scans all sessions under `~/.claude/projects`; human-readable titles.
- Parses the active chain, normalizes blocks, estimates tokens.
- Whole-context overview bar + "tokens by block type" breakdown + per-group drill-down.
- Groups by user turn; optional LLM topic-labeling (needs `ANTHROPIC_API_KEY`).
- Search: filter by title (instant) or full-text inside chats (on-demand grep, no index).

**v2 — context surgery (non-destructive)**
- Toggle **Edit context**, then per group/block:
  - **Drop group** — remove an entire turn-group.
  - **Drop/edit block** — remove or hand-edit a single block (e.g. a huge tool_result).
  - **Summarize → 1 turn** — replace a span with one LLM-written summary (needs API key).
- A sticky panel shows pending edits + projected token savings.
- **Save** writes a *new* `<newId>.jsonl` clone (original untouched) and prints the
  exact `claude --resume <newId>` command. Resume that to continue on the pruned context.

### How "continue chatting on the edited context" works
A Claude Code session resumes from its `.jsonl`. We write the edits to a brand-new
session file, repairing the `parentUuid` chain so it's a valid single line. Running
`claude --resume <newId>` from the original cwd loads the pruned context and lets you
keep chatting — new turns append to the clone, the original stays intact.

## Caveats (honest)

- **Token counts are approximate.** We use a local cl100k tokenizer, not Claude's
  exact tokenizer. Good for relative sizing; not for billing. (Future: Anthropic
  `count_tokens` endpoint for exact figures.)
- The encoded-cwd → path decode is best-effort (dir names can contain `-`).

## Run

```bash
npm install
npm run dev          # server on :4317, web on :5317
# open http://localhost:5317
```

Optional topic labeling:

```bash
export ANTHROPIC_API_KEY=sk-...
npm run dev:server
```

## Layout

```
packages/shared   normalized types (Message, ContentBlock, TurnGroup, ...)
packages/server   scanner + parser + tokenizer + grouping + labeler + Express API
packages/web      Vite + React UI (SessionPicker, ContextMap, drill-down)
```

# Findings

- The vault has one shared location for Codex and Claude, but no real graph: only 4 wiki links exist.
- `dev-command-center.md`, `active-context.md`, and `high-leverage-signals.md` duplicate the same inferred objectives.
- `semantic-memory.md` mixes durable trading facts, stale Anavi-main context, decisions, raw prompts, and auto-captured signals.
- `session-log.md` is an unbounded archive and must not be injected into working context.
- `/home/ariel/.codex/scripts/obsidian-memory-sync.js` writes multiple competing “current” notes.
- `/home/ariel/.codex/scripts/obsidian-memory-briefing.js` concatenates those notes and truncates at 11,000 characters.
- Current repo is `/home/ariel/anavitrade-trading`; stale `anavi-main` records should be archived or explicitly marked historical.

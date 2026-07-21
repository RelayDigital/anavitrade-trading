# Obsidian Knowledge Base Migration

## Goal

Turn the shared Codex/Claude Obsidian vault into a linked, typed knowledge base with a small trustworthy briefing.

## Phases

- [in_progress] Preserve and inventory current vault
- [pending] Create canonical linked vault structure and migrate useful content
- [pending] Update sync and briefing automation
- [pending] Validate links, boundaries, and generated briefing

## Guardrails

- Preserve existing notes in an archive before restructuring.
- Never load raw session logs or unreviewed capture into the briefing.
- Keep current operational truth separate from durable facts and decisions.
- Use Obsidian wiki links for relationships and evidence.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| External apply_patch blocked by sandbox network namespace | 1 | Use approved escalated command for vault/script writes |

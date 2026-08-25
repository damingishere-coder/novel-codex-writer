# Legacy compatibility inventory

This inventory records the compatibility surfaces reviewed during P3.1. The
repository-wide call search was performed before each deletion.

## Removed after zero-reference verification

- Unused formatting helpers in `frontend/src/lib/format.ts`.
- The unused `AI_SUGGESTION_SCHEMA` constant in `frontend/server/review-utils.ts`.
- The obsolete top-level AI suggestion reply shape; prompts and the enforced JSON
  schema have used `{ reply, suggestion }`, and Provider replies are not persisted
  as an interchange format.
- Unreferenced `.review-tabs` and `.accepted-note` CSS selectors.
- The duplicate, unused project/library resolver in `check_chapter.py`.
- The unused `openai` npm package; Provider calls use the existing native fetch
  and Codex subprocess adapters.
- The deprecated no-op `check_chapter.py --strict` flag. Repository-wide call
  search found no callers, and S1/S2 findings already fail without it.

## Preserved compatibility surfaces

- `build_context.py --max-section-chars`: deprecated alias retained until callers
  have migrated to `--budget-chars`.
- Schema v1 records, `legacy_unknown`, and old `章节提交/patch_classifications.json`
  reads: retained because existing local novels may still need migration.
- Legacy suggestion requests with `engine: "gpt"`: accepted only by the
  `/api/ai/suggest` request adapter and normalized to `deepseek`; stored settings,
  settings updates, and chapter-review requests reject it. The old stored
  `includeChapterContext` setting is read as an alias of
  `includeWritingTaskbook`; all new settings use the current field.
- Python and TypeScript chapter-check entry points remain for CLI and live UI,
  but both now consume the versioned `chapter-check-rules.json` corpus for word
  limits, engineering terms and style patterns. Algorithm changes must retain
  cross-entry regression coverage before either entry point can be removed.
- Historical design screenshots: retained while README/docs references are being
  treated as published documentation rather than runtime debris.

Do not remove a preserved surface without a migration command, fixture covering
an old real-world shape, and the full Python/Vitest/E2E validation gates.

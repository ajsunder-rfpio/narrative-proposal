# Edge functions

One thin function per agent action. Each `<action>/index.ts` authenticates,
loads graph state, calls the agent module, persists, and returns — the logic
lives in `_shared/handlers.ts` and the `src/agents` modules. No parsing,
drafting, or verification logic lives in a handler (per `CLAUDE.md`).

| Function           | Agent module     | Body                                   |
| ------------------ | ---------------- | -------------------------------------- |
| `intake-parse`     | `IntakeAgent`    | `{ pursuit_id }`                       |
| `outline-generate` | `OutlineAgent`   | `{ pursuit_id, template, style_guide? }` |
| `themes-draft`     | `ThemeAgent`     | `{ pursuit_id }`                       |
| `section-draft`    | `DraftingAgent`  | `{ pursuit_id, node_id, style_guide? }` |
| `claims-verify`    | `VerifierAgent`  | `{ pursuit_id, claim_id }`             |
| `evaluate`         | `EvaluatorAgent` | `{ pursuit_id, snapshot_id? }`         |

Every call requires `Authorization: Bearer <supabase-jwt>`; a missing or
invalid token returns 401 before any work.

## Architecture

Handlers are dependency-injected (`_shared/handlers.ts`): the Deno entrypoints
wire the real dependencies (`_shared/runtime.ts` — Supabase repository, the
`AnthropicLLM` adapter, the JWT verifier), and the vitest handler tests
(`src/agents/edge-handlers.test.ts`) wire mocks at the agent-module boundary.

Persistence is **load → run → persist**: `SupabaseGraphRepository.load` hydrates
a fresh in-memory `GraphStore` from the tables, the agent runs synchronously
against it, then `.save` dehydrates it back (via `GraphStore.exportPursuit` /
`importPursuit`). The store stays synchronous — its invariants are enforced
synchronously and agents call it without `await` — so the async DB boundary
lives in the repository, not in the store.

`_shared/deno.json` enables `sloppy-imports` so Deno can resolve the
extensionless relative imports in `src/` without editing source. If your
Supabase CLI does not honor it, the handler logic is still fully covered by the
vitest tests; only the Deno deployment path depends on it.

## Dev loop

```sh
supabase start                 # local Postgres + gateway (prints URL + keys)
# Apply the schema:
supabase db reset              # runs supabase/migrations/*.sql
# Copy the printed SUPABASE_URL / service-role key + ANTHROPIC_API_KEY into .env.local
supabase functions serve --env-file .env.local   # serves all functions
npm run dev                    # Vite front-end on :5173
```

Smoke-test a function (needs a valid JWT for the local project):

```sh
curl -s http://127.0.0.1:54321/functions/v1/evaluate \
  -H "Authorization: Bearer $SUPABASE_JWT" \
  -H "content-type: application/json" \
  -d '{"pursuit_id":"Pursuit_1"}'
```

## Known follow-ups (seams in place, not yet wired)

- **Source-content ingestion.** `runtime.sourceReader` returns `""`; fetching
  `IntakeSource.uri` from storage is a later branch. Until then the Intake
  agent grounds nothing in production (every fact drops — by design, never
  guessed).
- **Normalized columns.** Entities persist as JSONB with extracted key columns;
  column-per-field tables can follow without touching the export/import seam.

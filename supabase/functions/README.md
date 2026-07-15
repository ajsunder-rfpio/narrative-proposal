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

The edge bundle graph (everything under `supabase/functions/` plus the
`src/agents` and `src/graph` modules the entrypoints import) uses explicit
`.ts` import extensions. The Supabase CLI's bundled Deno runtime requires them
(it does not honor `sloppy-imports`), and Vite/Node accept them via
`allowImportingTsExtensions` in `tsconfig.json` — so both sides resolve the same
files. The UI, tests, and the barrel/`orchestrator` modules are not in the edge
bundle and keep the extensionless style.

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

## Intake source content

Uploads land in the private `intake-sources` Storage bucket (migration
`0002`); an `IntakeSource.uri` is `"<bucket>/<path>"`. `runtime.sourceReader`
downloads the object and decodes it: `.txt`/`.md` and `.csv` as UTF-8, `.docx`
by unzip + text extraction, and `data:` URIs for pasted text. An unreadable,
empty, or unsupported source is recorded as `parse_status: "failed"` with a
reason; that source grounds nothing and its fields report `not_found`.

**PDF is not implemented** — see the maintainer note; a `.pdf` source fails
with an explicit reason rather than pulling a heavy extractor into the runtime.

## Known follow-ups (seams in place, not yet wired)

- **PDF ingestion.** Deferred (heavy edge dependency); currently a `.pdf`
  source fails with a clear reason.
- **Normalized columns.** Entities persist as JSONB with extracted key columns;
  column-per-field tables can follow without touching the export/import seam.

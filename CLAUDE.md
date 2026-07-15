# narrative-proposal

Narrative proposal workspace: intake → outline → themes → drafting → review → export, with AI agents doing structural and drafting labor over a proposal graph, and humans supplying strategy, judgment, and approval.

The spec artifacts (object model, agent definitions, UX doctrine, pattern inventory, surface requirements) live in `docs/spec/`. They are the source of truth. If code and spec disagree, say so and stop.

## Non-negotiable

The model never asserts state it doesn't own:

- `coverage_status` on a Requirement is computed in TypeScript from mappings, section status, and claim verification. No agent writes it.
- `verification_status` on a Claim is written only by the Verifier, as a separate entailment call. The drafting agent never verifies its own claims.
- No agent overwrites human-authored content. Agents write new SectionRevisions or new draft records; humans accept, edit, or reject.
- Only the Orchestrator writes `pursuit.stage`. Two human gates: themes must be human-locked before drafting starts; export requires a human click.
- A claim that fails verification renders flagged as unsupported. Nothing removes or rewrites it silently. Export with unsupported claims proceeds with a loud warning listing each one (ratified: warn, never hard-block).
- Every library-sourced assertion in a draft carries a Citation to a Passage. When retrieval finds nothing for a needed proof point, the draft contains an explicit gap marker, never smooth prose over the hole.
- OutlineNode IDs are permanent and never reused. Node identity is the contract the Word add-in will inherit. Bindings degrade loudly, never silently.

If you believe one of these is wrong, say so and stop. Do not work around it.

Do not add defensive machinery for failures that haven't been observed.

## Tests: both must pass before any commit

npm test -- graph        # graph invariants: write scopes, gates, coverage computation
npm test -- agents       # agent contracts against fixture pursuits, incl. a deliberately hallucinating fake LLM

(Created by the scaffold; keep the names stable.)

## Environment

Vite 5 + @vitejs/plugin-react-swc 3.x. Do not upgrade Vite; Lovable builds against
these versions. package-lock.json drift is expected (Lovable uses Bun). Discard it
rather than committing it.

Supabase edge functions (Deno) for agent endpoints. Edge handlers are thin: they
call into `agents/` and `graph/` modules and nothing else. No parsing, drafting,
or verification logic in handlers.

Lovable syncs `main` two-way. Every commit here reaches Lovable automatically.
Only one of Lovable or Claude Code writes to `main` at a time. Work happens on a
branch, merges to `main` when the tests pass and the feature has been driven
locally.

## UI changes

Keep UI work in frontend and presentation code unless business logic is in scope.
The approved Claude Design states in `docs/design/` define every screen; purple is
AI-only, black is human-commit, blocked states always name their gate.

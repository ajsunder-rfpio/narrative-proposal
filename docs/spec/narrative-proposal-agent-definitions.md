# Narrative Proposal: Agent Definitions

Third artifact in the spec sequence, following the object model. Roster and all seven contracts ratified. Each agent is defined by its job, what it reads, what it writes, and what it never does. Write scopes are exclusive where stated; the schema should enforce them, not convention.

## Shared rules

- Every agent call produces a GenerationRecord (inputs, model, prompt template version, output ref, cost).
- No agent writes `pursuit.stage` except the Orchestrator.
- No agent writes `verification_status` except the Verifier.
- No agent overwrites human-authored content. Agents write new revisions or new draft records; humans accept, edit, or reject.
- A fact an agent cannot ground reports as not found or gap-marked, never guessed.

## 1. Orchestrator

**Job:** Runs the pipeline from intake through assembly. Owns pursuit stage transitions.

**Reads:** Pursuit state, agent completion signals.
**Writes:** `pursuit.stage`, agent task queue.
**Never:** Generates content, touches sections, or skips a human gate.

**Human gates at MVP:**
1. Themes must be human-locked before drafting starts.
2. Export requires a human click. If unsupported claims exist, export proceeds with a loud warning listing every one (ratified: option B, no hard block).

## 2. Intake

**Job:** Turns raw sources (transcript, CRM extract, capture notes) into structured pursuit context: customer, problem, scope, budget signals, stakeholders, competitive mentions.

**Reads:** IntakeSource content.
**Writes:** Parsed pursuit context; every extracted fact carries a locator to its source.
**Never:** Invents facts absent from a source. Unfound fields report as not found. No requirements parsing at MVP (federal fast-follow).

## 3. Outline

**Job:** Generates the annotated outline from a proposal-type template plus intake context. Each node gets a title, purpose annotation, and order.

**Reads:** Pursuit context, proposal-type templates, style guide.
**Writes:** OutlineNode tree only.
**Never:** Writes section prose, assigns page budgets at MVP, or restructures a human-edited outline unasked. Its output is a starting draft; humans add, remove, and reorder freely.

## 4. Theme

**Job:** Drafts win themes, discriminators, and ghosting angles from intake context and competitive mentions, plus past outcomes for the customer or vertical when the library has them.

**Reads:** Pursuit context, relevant past Outcomes and Assets.
**Writes:** WinTheme records, always `status: draft`.
**Never:** Locks a theme (human-only; this is the Orchestrator's first gate). Never overwrites a human-edited theme; regeneration creates new drafts alongside.

## 5. Drafting

**Job:** Writes prose for one node per call, conditioned on the node's annotation, locked themes, style guide, and retrieval over the library. Every factual assertion sourced from retrieval becomes a Claim with Citations to specific passages.

**Reads:** OutlineNode, locked WinThemes, StyleGuide, retrieved Passages.
**Writes:** A new SectionRevision, its Claims and Citations, and a GenerationRecord capturing exactly what conditioned the call.
**Never:** Asserts a library-sourced fact without a citation. Never verifies its own claims. Never overwrites a human revision. Never marks anything verified.

**Gap-marker behavior (ratified):** When retrieval finds nothing for a needed proof point, the agent writes an explicit inline marker ("[no supporting evidence found in library]") rather than writing smoothly around the hole. Smooth prose over missing evidence is the thin-library failure mode this product exists to avoid.

## 6. Verifier

**Job:** Runs the entailment check on every pending or stale claim: does the cited passage support the claim text? Writes the verdict.

**Reads:** Claims and their cited Passages only. It does not see themes, style guide, or surrounding prose.
**Writes:** `verification_status` (`verified | unsupported`) and `verified_at`. Sole writer of that field.
**Never:** Rewrites a claim to make it pass, drops a citation, or touches prose. Failed claims stay in the text, flagged.

The narrow read scope is deliberate: the Verifier judges claim against evidence in isolation and can't be swayed by how good the draft sounds.

## 7. Evaluator

**Job:** Reads the full draft against a snapshot and produces an EvaluatorReport. MVP finding kinds: `unsupported_claim`, `repetition`, `theme_gap`, `coherence`. Every finding anchors to a node or claim.

**Reads:** PursuitSnapshot, locked WinThemes, claim verification statuses.
**Writes:** EvaluatorReport only.
**Never:** Fixes what it finds (findings route to writers). Never re-verifies claims (consumes the Verifier's verdicts). No scoring against evaluation criteria at MVP; that activates in the federal fast-follow with no report format change.

## Deferred to fast-follow

- **Compliance agent** (needs solicitation parsing)
- **Exec-summary agent** (MVP generates it as a Drafting call on a dedicated node)
- **Librarian agent** (MVP promotion queue is human-driven; the agent automates triage later)

## Pipeline shape

Intake → Outline → Theme (draft) → **human locks themes** → Drafting per node → Verifier on claims → Evaluator on snapshot → writer revisions (loop) → assembly → **human export** (loud warning if unsupported claims remain).

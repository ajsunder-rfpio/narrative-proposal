# Narrative Proposal: Object Model

Second artifact in the spec sequence, following the MVP scope decision (commercial proactive proposal first, federal fast-follow). The schema is federal-complete from day one: every govcon entity exists at launch, and a commercial pursuit simply has zero requirements, no review cycles beyond a basic pass, and no page budgets. The federal fast-follow adds parsers and UI on top of this model. It adds no tables.

The graph in one sentence: a Pursuit owns an outline tree; requirements bind to outline nodes; sections hold versioned content whose claims cite library passages; themes, style, and retrieved evidence condition every generation; and every AI call, review comment, and outcome anchors to a node in this graph.

## Entities

### Pursuit
The root aggregate.

- `id`, `org_id`, `name`
- `account_ref` (CRM link)
- `kind`: `proactive_proposal | rfp_response | federal_volume | grant | sow_response`
- `stage`: `intake | outline | drafting | review | assembly | submitted | closed`
- `classification`: `none | cui | itar` (enum exists at launch; handling policy deferred)
- `style_guide_id`, `owner_id`, `members[]` (user + role)
- `created_at`, `submitted_at`

### IntakeSource
Anything the pursuit starts from. One model for both segments.

- `id`, `pursuit_id`
- `kind`: `solicitation | transcript | crm_extract | capture_notes`
- `uri`, `parse_status`

A federal pursuit has a solicitation source that yields requirements. A commercial pursuit has a transcript and CRM extract that yield context for themes and outline. Same table, different kinds.

### Requirement
Parsed obligation from an intake source. Empty set for most commercial pursuits.

- `id`, `pursuit_id`, `source_ref` (IntakeSource + locator)
- `kind`: `instruction | evaluation_criterion | deliverable | constraint`
- `text`, `priority`: `shall | should | may`
- `coverage_status` (computed, never stored as agent output): `unmapped | mapped | addressed | verified`

Page limits and format rules are requirements of kind `constraint`, so the compliance matrix covers them without a separate mechanism. Section L instructions and Section M criteria are both requirements, distinguished by `kind`.

### RequirementMapping
Many-to-many join: `requirement_id`, `outline_node_id`, `created_by` (human | agent), `confirmed_by`.

### OutlineNode
The structural unit and the identity unit. Node IDs are what Word content controls will carry in the fast-follow, so they are stable, never reused, and survive reordering.

- `id`, `pursuit_id`, `parent_id`, `order`
- `title`, `annotation` (purpose, evaluator guidance)
- `page_budget` (nullable)
- `assignee_id`
- `status`: `empty | drafting | in_review | final`

### Section
Content body of a leaf node. One-to-one with leaf OutlineNodes; separate entity so content lifecycle (revisions, locks, edit surface) stays out of the structure tree.

- `id`, `node_id`, `current_revision_id`
- `lock` (editor + surface: `canvas | word`)

### SectionRevision
Immutable content snapshots forming the edit history.

- `id`, `section_id`, `parent_revision_id`
- `author` (user or agent identity)
- `content` (rich text with embedded claim anchors)
- `generation_record_id` (nullable; set when AI-authored)
- `created_at`

### WinTheme
- `id`, `pursuit_id`
- `kind`: `theme | discriminator | ghost`
- `text`, `scope` (pursuit-wide or node ids)
- `status`: `draft | locked`, `version`

Only locked themes condition generation. Theme versions are captured in GenerationRecord so a draft can always answer "which strategy produced this."

### Claim
A factual assertion in section prose that is sourced from the library. Created by the drafting agent at generation time for every assertion it grounds in retrieval.

- `id`, `section_id`
- `anchor` (span within a revision; re-anchored across revisions by diff)
- `text`
- `verification_status`: `pending | verified | unsupported | stale`
- `verified_at`, `method`

Semantics: verification is an entailment check of the claim text against its cited passages, run as a separate model call from drafting. Verbatim matching does not transfer from the extraction pipeline because narrative paraphrases by design; entailment is the analogue. A human edit that intersects a claim's span sets it to `stale`; edits elsewhere in the section leave it `verified`. A claim that fails verification renders flagged as unsupported. Nothing removes or rewrites it silently.

### Citation
The audit-trail object. One claim, one or more citations.

- `id`, `claim_id`, `asset_id`, `passage_id`
- `quote` (verbatim passage excerpt), `locator` (page or heading within the asset)

### Asset
Governed library item for narrative reuse.

- `id`, `org_id`
- `kind`: `past_proposal_section | case_study | past_performance | resume | product_doc | boilerplate`
- `title`, `source_uri`
- `metadata`: customer, vertical, contract_vehicle, outcome (win/loss), date
- `sensitivity`: `public | internal | cui` (enum at launch, policy deferred)
- `governance`: approved_by, review_date, expiry

### Passage
Hierarchical chunks of an asset: `id`, `asset_id`, `parent_id`, `text`, `locator`. Retrieval and citations both address passages, never raw offsets.

### AssetLink
The light knowledge graph: typed edges `asset ↔ person | customer | outcome | asset`, with `kind` (e.g. `features_person`, `describes_outcome`, `supersedes`). Enough for drafting agents to pull evidence chains (this case study, that named engineer, that measured outcome) without a full graph database.

### GenerationRecord
Provenance for every AI call. Doubles as the metering ledger and the ISO 42001 audit artifact.

- `id`, `pursuit_id`, `agent`
- `inputs`: node_id, requirement_ids, theme_versions, style_guide_version, retrieved_passage_ids, prompt_template_version, model
- `output_revision_id`
- `tokens`, `cost_units`, `created_at`

### ReviewCycle and ReviewComment
- ReviewCycle: `id`, `pursuit_id`, `kind` (`commercial_review | pink | red | gold`), `baseline_snapshot_id`, `reviewers[]`, `status`, `due_at`
- ReviewComment: `id`, `cycle_id`, `anchor` (node, section, or claim), `text`, `author_id`, `status` (`open | resolved`)

Color-team kinds exist at launch; MVP uses `commercial_review` only.

### PursuitSnapshot
Immutable graph snapshot: `id`, `pursuit_id`, `label`, `created_at`. Review baselines and the submission record are snapshots, so "what did red team actually read" and "what did we ship" are always answerable.

### EvaluatorReport
Output of the evaluator agent against a snapshot or live state.

- `id`, `pursuit_id`, `snapshot_id`
- `findings[]`: kind (`unaddressed_requirement | unsupported_claim | repetition | theme_gap | page_overrun | coherence`), anchor, detail, severity
- `scores[]` (only when evaluation criteria exist on the pursuit)

MVP emits `unsupported_claim`, `repetition`, `theme_gap`, and `coherence`. The other two kinds activate when requirements and page budgets are present, with no report format change.

### Outcome and PromotionCandidate
- Outcome: `id`, `pursuit_id`, `result` (`win | loss | no_decision`), `notes`, `tagged_at`
- PromotionCandidate: `id`, `section_revision_id`, `proposed_asset` (metadata prefilled from the pursuit), `status` (`queued | approved | rejected`), `reviewed_by`

The librarian queue. This is the closed loop, and it ships at MVP.

### StyleGuide
Versioned per org, overridable per pursuit: `id`, `org_id`, `version`, `content`.

### User roles
`proposal_manager | writer | capture | ae | reviewer | librarian`. Kept minimal; permissions design comes with requirements, not here.

## Load-bearing semantics

**Coverage is computed, never asserted.** `coverage_status` on Requirement derives from RequirementMappings, section status, and claim verification. No agent writes it. Same doctrine as counts in the extraction pipeline.

**Node identity is the Word contract.** The fast-follow add-in embeds OutlineNode IDs in content controls. A sync that cannot preserve a node's control marks that node's bindings (mappings, claims, comments) as `stale` and says so in the UI. Bindings degrade loudly, never silently, and never disappear.

**Themes condition via prompt plus post-check.** Locked themes are injected into drafting calls, and the evaluator's `theme_gap` finding verifies coverage after the fact. This resolves the open question from the narrative: structured constraints on free prose aren't enforceable at generation time, so enforcement moves to a check that anchors findings to nodes. The GenerationRecord makes the conditioning auditable either way.

**Verification is a separate call.** The drafting agent proposes claims and citations; a verifier agent runs entailment checks and writes `verification_status`. Drafting never grades its own work.

## Decisions embedded here that need your sign-off

1. **Claim verification method**: entailment check against cited passages, as a distinct verification call. The export policy for unsupported claims (hard block versus loud warning at assembly) is still open and belongs in requirements.
2. **Claim staleness rule**: re-anchor spans by diff across revisions; only edits intersecting a claim's span invalidate it. The stricter alternative (any section edit invalidates all its claims) is safer and much noisier.
3. **OutlineNode/Section split** with node ID as the permanent identity unit for Word sync. This is the schema commitment the add-in inherits; it can't be revisited cheaply later.
4. **Constraints as requirements**: page limits and format rules live in the Requirement table under kind `constraint` rather than as a parallel mechanism.
5. **Theme conditioning** as prompt injection plus evaluator post-check, closing that open question from the narrative.

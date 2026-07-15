// Object model for the narrative-proposal graph.
//
// Source of truth: docs/spec/narrative-proposal-object-model.md. Every entity in
// that document has a type here. Two fields from the spec are deliberately NOT
// stored as writable fields on their records, because the spec forbids the model
// from asserting state it does not own:
//
//   - Requirement.coverage_status  — computed (see coverage.ts), never stored.
//   - Claim.verification_status    — present, but only the Verifier interface and
//                                     the store's re-anchoring logic may write it.
//
// Enforcement of those write scopes lives in store.ts, not in convention.

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Branded id types keep the many id fields from being accidentally swapped. */
export type Id<T extends string> = string & { readonly __brand: T };

export type PursuitId = Id<"Pursuit">;
export type IntakeSourceId = Id<"IntakeSource">;
export type RequirementId = Id<"Requirement">;
export type RequirementMappingId = Id<"RequirementMapping">;
export type OutlineNodeId = Id<"OutlineNode">;
export type SectionId = Id<"Section">;
export type SectionRevisionId = Id<"SectionRevision">;
export type WinThemeId = Id<"WinTheme">;
export type ClaimId = Id<"Claim">;
export type CitationId = Id<"Citation">;
export type AssetId = Id<"Asset">;
export type PassageId = Id<"Passage">;
export type AssetLinkId = Id<"AssetLink">;
export type GenerationRecordId = Id<"GenerationRecord">;
export type ReviewCycleId = Id<"ReviewCycle">;
export type ReviewCommentId = Id<"ReviewComment">;
export type PursuitSnapshotId = Id<"PursuitSnapshot">;
export type EvaluatorReportId = Id<"EvaluatorReport">;
export type OutcomeId = Id<"Outcome">;
export type PromotionCandidateId = Id<"PromotionCandidate">;
export type StyleGuideId = Id<"StyleGuide">;
export type UserId = Id<"User">;
export type OrgId = Id<"Org">;

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export type UserRole =
  | "proposal_manager"
  | "writer"
  | "capture"
  | "ae"
  | "reviewer"
  | "librarian";

export type AgentName =
  | "orchestrator"
  | "intake"
  | "outline"
  | "theme"
  | "drafting"
  | "verifier"
  | "evaluator";

/** Content and records carry an authoring identity: a human user or an agent. */
export type Authorship =
  | { readonly by: "user"; readonly user_id: UserId }
  | { readonly by: "agent"; readonly agent: AgentName };

export interface PursuitMember {
  readonly user_id: UserId;
  readonly role: UserRole;
}

// ---------------------------------------------------------------------------
// Pursuit (root aggregate)
// ---------------------------------------------------------------------------

export type PursuitKind =
  | "proactive_proposal"
  | "rfp_response"
  | "federal_volume"
  | "grant"
  | "sow_response";

export type PursuitStage =
  | "intake"
  | "outline"
  | "drafting"
  | "review"
  | "assembly"
  | "submitted"
  | "closed";

export type Classification = "none" | "cui" | "itar";

export interface Pursuit {
  readonly id: PursuitId;
  readonly org_id: OrgId;
  readonly name: string;
  readonly account_ref: string | null;
  readonly kind: PursuitKind;
  /** Write scope: Orchestrator interface only. */
  readonly stage: PursuitStage;
  readonly classification: Classification;
  readonly style_guide_id: StyleGuideId | null;
  readonly owner_id: UserId;
  readonly members: readonly PursuitMember[];
  readonly created_at: string;
  readonly submitted_at: string | null;
}

// ---------------------------------------------------------------------------
// Intake / requirements
// ---------------------------------------------------------------------------

export type IntakeSourceKind =
  | "solicitation"
  | "transcript"
  | "crm_extract"
  | "capture_notes";

export type ParseStatus = "pending" | "parsing" | "parsed" | "failed";

export interface IntakeSource {
  readonly id: IntakeSourceId;
  readonly pursuit_id: PursuitId;
  readonly kind: IntakeSourceKind;
  readonly uri: string;
  readonly parse_status: ParseStatus;
}

export type RequirementKind =
  | "instruction"
  | "evaluation_criterion"
  | "deliverable"
  | "constraint";

export type RequirementPriority = "shall" | "should" | "may";

/**
 * A parsed obligation. Note there is NO `coverage_status` field: coverage is a
 * pure function of mappings, section status, and claim verification (coverage.ts).
 * The spec forbids storing it, so the type cannot express it.
 */
export interface Requirement {
  readonly id: RequirementId;
  readonly pursuit_id: PursuitId;
  readonly source_ref: {
    readonly source_id: IntakeSourceId;
    readonly locator: string;
  };
  readonly kind: RequirementKind;
  readonly text: string;
  readonly priority: RequirementPriority;
}

/** The computed value coverage.ts returns; never persisted on Requirement. */
export type CoverageStatus = "unmapped" | "mapped" | "addressed" | "verified";

export type MappingActor = "human" | "agent";

export interface RequirementMapping {
  readonly id: RequirementMappingId;
  readonly requirement_id: RequirementId;
  readonly outline_node_id: OutlineNodeId;
  readonly created_by: MappingActor;
  readonly confirmed_by: UserId | null;
}

// ---------------------------------------------------------------------------
// PursuitContext — the Intake agent's structured output.
//
// SPEC GAP: the ratified object model (object-model.md) does not table "pursuit
// context", yet the Intake contract (agent-definitions.md #2) says the agent
// "Writes: Parsed pursuit context; every extracted fact carries a locator to its
// source." This type is that artifact, modeled as stored pursuit state. It is
// deliberately NOT a ratified entity — surfaced here rather than smuggled in.
// ---------------------------------------------------------------------------

export type ContextFieldKey =
  | "customer"
  | "problem"
  | "scope"
  | "budget_signals"
  | "stakeholders"
  | "competitive_mentions";

/** Every extracted fact carries a locator back to the source it came from. */
export interface SourceLocator {
  readonly source_id: IntakeSourceId;
  readonly locator: string;
}

export interface ContextFact {
  readonly key: ContextFieldKey;
  readonly value: string;
  readonly source: SourceLocator;
}

export type ContextFieldStatus = "found" | "not_found";

/** One entry per context field. `not_found` is an explicit report, not silence. */
export interface ContextField {
  readonly key: ContextFieldKey;
  readonly status: ContextFieldStatus;
  readonly facts: readonly ContextFact[];
}

export interface PursuitContext {
  readonly pursuit_id: PursuitId;
  readonly fields: readonly ContextField[];
  readonly generation_record_id: GenerationRecordId | null;
}

// ---------------------------------------------------------------------------
// Structure: OutlineNode + Section + SectionRevision
// ---------------------------------------------------------------------------

export type OutlineNodeStatus = "empty" | "drafting" | "in_review" | "final";

/**
 * The structural unit AND the identity unit. IDs are permanent, never reused,
 * and survive rename/reorder — they are the contract the Word add-in inherits.
 */
export interface OutlineNode {
  readonly id: OutlineNodeId;
  readonly pursuit_id: PursuitId;
  readonly parent_id: OutlineNodeId | null;
  readonly order: number;
  readonly title: string;
  readonly annotation: string;
  readonly page_budget: number | null;
  readonly assignee_id: UserId | null;
  readonly status: OutlineNodeStatus;
}

export type EditSurface = "canvas" | "word";

export interface SectionLock {
  readonly editor_id: UserId;
  readonly surface: EditSurface;
}

/** Content body of a leaf node. Points at the head of its revision chain. */
export interface Section {
  readonly id: SectionId;
  readonly node_id: OutlineNodeId;
  readonly current_revision_id: SectionRevisionId | null;
  readonly lock: SectionLock | null;
}

/** Immutable content snapshot. Never mutated in place; new revisions append. */
export interface SectionRevision {
  readonly id: SectionRevisionId;
  readonly section_id: SectionId;
  readonly parent_revision_id: SectionRevisionId | null;
  readonly author: Authorship;
  readonly content: string;
  readonly generation_record_id: GenerationRecordId | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Strategy: WinTheme
// ---------------------------------------------------------------------------

export type WinThemeKind = "theme" | "discriminator" | "ghost";
export type WinThemeStatus = "draft" | "locked";

/** `scope`: pursuit-wide, or scoped to specific outline nodes. */
export type WinThemeScope =
  | { readonly kind: "pursuit" }
  | { readonly kind: "nodes"; readonly node_ids: readonly OutlineNodeId[] };

export interface WinTheme {
  readonly id: WinThemeId;
  readonly pursuit_id: PursuitId;
  readonly kind: WinThemeKind;
  readonly text: string;
  readonly scope: WinThemeScope;
  /** Write scope: only a human may set `locked` (Orchestrator's first gate). */
  readonly status: WinThemeStatus;
  readonly version: number;
}

// ---------------------------------------------------------------------------
// Grounding: Claim + Citation
// ---------------------------------------------------------------------------

export type VerificationStatus = "pending" | "verified" | "unsupported" | "stale";

/** A span within a revision; re-anchored across revisions by diff. */
export interface ClaimAnchor {
  readonly revision_id: SectionRevisionId;
  readonly start: number;
  readonly end: number;
}

export interface Claim {
  readonly id: ClaimId;
  readonly section_id: SectionId;
  readonly anchor: ClaimAnchor;
  readonly text: string;
  /** Write scope: Verifier interface (verified|unsupported) and the store's
   *  re-anchoring on revision commit (stale) only. Never an agent field. */
  readonly verification_status: VerificationStatus;
  readonly verified_at: string | null;
  readonly method: string | null;
}

export interface Citation {
  readonly id: CitationId;
  readonly claim_id: ClaimId;
  readonly asset_id: AssetId;
  readonly passage_id: PassageId;
  readonly quote: string;
  readonly locator: string;
}

// ---------------------------------------------------------------------------
// Library: Asset + Passage + AssetLink
// ---------------------------------------------------------------------------

export type AssetKind =
  | "past_proposal_section"
  | "case_study"
  | "past_performance"
  | "resume"
  | "product_doc"
  | "boilerplate";

export type Sensitivity = "public" | "internal" | "cui";

export interface AssetGovernance {
  readonly approved_by: UserId | null;
  readonly review_date: string | null;
  readonly expiry: string | null;
}

export interface AssetMetadata {
  readonly customer: string | null;
  readonly vertical: string | null;
  readonly contract_vehicle: string | null;
  readonly outcome: "win" | "loss" | null;
  readonly date: string | null;
}

export interface Asset {
  readonly id: AssetId;
  readonly org_id: OrgId;
  readonly kind: AssetKind;
  readonly title: string;
  readonly source_uri: string;
  readonly metadata: AssetMetadata;
  readonly sensitivity: Sensitivity;
  readonly governance: AssetGovernance;
}

export interface Passage {
  readonly id: PassageId;
  readonly asset_id: AssetId;
  readonly parent_id: PassageId | null;
  readonly text: string;
  readonly locator: string;
}

export type AssetLinkKind =
  | "features_person"
  | "describes_outcome"
  | "supersedes"
  | string;

export type AssetLinkTarget = "person" | "customer" | "outcome" | "asset";

export interface AssetLink {
  readonly id: AssetLinkId;
  readonly asset_id: AssetId;
  readonly target: AssetLinkTarget;
  readonly target_ref: string;
  readonly kind: AssetLinkKind;
}

// ---------------------------------------------------------------------------
// Provenance: GenerationRecord
// ---------------------------------------------------------------------------

export interface GenerationInputs {
  readonly node_id: OutlineNodeId | null;
  readonly requirement_ids: readonly RequirementId[];
  readonly theme_versions: readonly { readonly theme_id: WinThemeId; readonly version: number }[];
  readonly style_guide_version: number | null;
  readonly retrieved_passage_ids: readonly PassageId[];
  readonly prompt_template_version: string;
  readonly model: string;
}

export interface GenerationRecord {
  readonly id: GenerationRecordId;
  readonly pursuit_id: PursuitId;
  readonly agent: AgentName;
  readonly inputs: GenerationInputs;
  readonly output_revision_id: SectionRevisionId | null;
  readonly tokens: number;
  readonly cost_units: number;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Review: ReviewCycle + ReviewComment + PursuitSnapshot
// ---------------------------------------------------------------------------

export type ReviewCycleKind = "commercial_review" | "pink" | "red" | "gold";
export type ReviewCycleStatus = "open" | "closed";

export interface ReviewCycle {
  readonly id: ReviewCycleId;
  readonly pursuit_id: PursuitId;
  readonly kind: ReviewCycleKind;
  readonly baseline_snapshot_id: PursuitSnapshotId | null;
  readonly reviewers: readonly UserId[];
  readonly status: ReviewCycleStatus;
  readonly due_at: string | null;
}

export type ReviewCommentStatus = "open" | "resolved";

/** Anchor targets a node, a section, or a claim. */
export type ReviewAnchor =
  | { readonly kind: "node"; readonly node_id: OutlineNodeId }
  | { readonly kind: "section"; readonly section_id: SectionId }
  | { readonly kind: "claim"; readonly claim_id: ClaimId };

export interface ReviewComment {
  readonly id: ReviewCommentId;
  readonly cycle_id: ReviewCycleId;
  readonly anchor: ReviewAnchor;
  readonly text: string;
  readonly author_id: UserId;
  readonly status: ReviewCommentStatus;
}

export interface PursuitSnapshot {
  readonly id: PursuitSnapshotId;
  readonly pursuit_id: PursuitId;
  readonly label: string;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Evaluation: EvaluatorReport
// ---------------------------------------------------------------------------

export type EvaluatorFindingKind =
  | "unaddressed_requirement"
  | "unsupported_claim"
  | "repetition"
  | "theme_gap"
  | "page_overrun"
  | "coherence";

export type FindingSeverity = "info" | "warning" | "critical";

export interface EvaluatorFinding {
  readonly kind: EvaluatorFindingKind;
  readonly anchor: ReviewAnchor;
  readonly detail: string;
  readonly severity: FindingSeverity;
}

export interface EvaluatorScore {
  readonly requirement_id: RequirementId;
  readonly score: number;
  readonly rationale: string;
}

export interface EvaluatorReport {
  readonly id: EvaluatorReportId;
  readonly pursuit_id: PursuitId;
  readonly snapshot_id: PursuitSnapshotId | null;
  readonly findings: readonly EvaluatorFinding[];
  readonly scores: readonly EvaluatorScore[];
}

// ---------------------------------------------------------------------------
// Closed loop: Outcome + PromotionCandidate
// ---------------------------------------------------------------------------

export type OutcomeResult = "win" | "loss" | "no_decision";

export interface Outcome {
  readonly id: OutcomeId;
  readonly pursuit_id: PursuitId;
  readonly result: OutcomeResult;
  readonly notes: string;
  readonly tagged_at: string;
}

export type PromotionStatus = "queued" | "approved" | "rejected";

export interface PromotionCandidate {
  readonly id: PromotionCandidateId;
  readonly section_revision_id: SectionRevisionId;
  readonly proposed_asset: Partial<AssetMetadata> & { readonly title: string };
  readonly status: PromotionStatus;
  readonly reviewed_by: UserId | null;
}

// ---------------------------------------------------------------------------
// StyleGuide
// ---------------------------------------------------------------------------

export interface StyleGuide {
  readonly id: StyleGuideId;
  readonly org_id: OrgId;
  readonly version: number;
  readonly content: string;
}

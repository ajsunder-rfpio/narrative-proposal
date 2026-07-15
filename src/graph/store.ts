import { computeCoverageStatus, type CoverageView } from "./coverage";
import { IdFactory } from "./ids";
import type {
  Authorship,
  Citation,
  Claim,
  ClaimId,
  CoverageStatus,
  GenerationInputs,
  GenerationRecord,
  IntakeSource,
  IntakeSourceKind,
  OutlineNode,
  OutlineNodeId,
  OutlineNodeStatus,
  Passage,
  Asset,
  Pursuit,
  PursuitId,
  PursuitKind,
  PursuitSnapshot,
  Requirement,
  RequirementId,
  RequirementKind,
  RequirementMapping,
  RequirementMappingId,
  RequirementPriority,
  Section,
  SectionId,
  SectionRevision,
  SectionRevisionId,
  UserId,
  WinTheme,
  WinThemeId,
  WinThemeKind,
  WinThemeScope,
  AgentName,
  ParseStatus,
} from "./types";

/** Thrown when a caller attempts a write outside its granted scope, or trips a
 *  human gate. Message always names the violated rule. */
export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

/** Recursively freeze so records handed to callers cannot be mutated in place —
 *  the model never lets outside code edit graph state directly. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

// ---------------------------------------------------------------------------
// Scoped write interfaces. These are the ONLY doors to the guarded fields.
// ---------------------------------------------------------------------------

/** Sole writer of `pursuit.stage`. Enforces the two MVP human gates. */
export interface OrchestratorScope {
  setStage(
    pursuitId: PursuitId,
    target: Pursuit["stage"],
    opts?: { readonly humanExportConfirmed?: boolean },
  ): Pursuit;
}

/** Sole writer of `claim.verification_status` (to verified|unsupported). */
export interface VerifierScope {
  setVerificationStatus(
    claimId: ClaimId,
    verdict: "verified" | "unsupported",
    opts?: { readonly method?: string; readonly verified_at?: string },
  ): Claim;
}

export interface GraphStoreOptions {
  /** Injectable clock keeps created_at deterministic in tests. */
  readonly clock?: () => string;
}

/**
 * In-memory proposal graph with the CLAUDE.md write scopes enforced in code:
 *
 *   - pursuit.stage         → only via orchestrator()
 *   - claim.verification_status → only via verifier() (+ internal staleness)
 *   - section content       → only as new immutable SectionRevisions
 *   - Requirement coverage  → computed (coverageStatus), never stored
 *   - OutlineNode ids       → permanent, never reused, survive rename/reorder
 *
 * The generic update* mutators explicitly refuse the guarded fields, and every
 * record returned is deep-frozen, so there is no back door.
 */
export class GraphStore implements CoverageView {
  private readonly ids = new IdFactory();
  private readonly now: () => string;

  private readonly pursuits = new Map<PursuitId, Pursuit>();
  private readonly intakeSources = new Map<IntakeSource["id"], IntakeSource>();
  private readonly requirements = new Map<RequirementId, Requirement>();
  private readonly mappings = new Map<RequirementMappingId, RequirementMapping>();
  private readonly nodes = new Map<OutlineNodeId, OutlineNode>();
  private readonly sections = new Map<SectionId, Section>();
  private readonly sectionByNode = new Map<OutlineNodeId, SectionId>();
  private readonly revisions = new Map<SectionRevisionId, SectionRevision>();
  private readonly themes = new Map<WinThemeId, WinTheme>();
  private readonly claims = new Map<ClaimId, Claim>();
  private readonly claimsBySection = new Map<SectionId, ClaimId[]>();
  private readonly citations = new Map<Citation["id"], Citation>();
  private readonly assets = new Map<Asset["id"], Asset>();
  private readonly passages = new Map<Passage["id"], Passage>();
  private readonly generationRecords = new Map<
    GenerationRecord["id"],
    GenerationRecord
  >();
  private readonly snapshots = new Map<PursuitSnapshot["id"], PursuitSnapshot>();

  constructor(opts: GraphStoreOptions = {}) {
    this.now = opts.clock ?? (() => new Date().toISOString());
  }

  // -------------------------------------------------------------------------
  // Pursuit
  // -------------------------------------------------------------------------

  createPursuit(input: {
    org_id: Pursuit["org_id"];
    name: string;
    kind: PursuitKind;
    owner_id: UserId;
    account_ref?: string | null;
    classification?: Pursuit["classification"];
    style_guide_id?: Pursuit["style_guide_id"];
    members?: Pursuit["members"];
  }): Pursuit {
    const pursuit: Pursuit = {
      id: this.ids.mint("Pursuit"),
      org_id: input.org_id,
      name: input.name,
      account_ref: input.account_ref ?? null,
      kind: input.kind,
      stage: "intake", // initial stage; only orchestrator() moves it after this
      classification: input.classification ?? "none",
      style_guide_id: input.style_guide_id ?? null,
      owner_id: input.owner_id,
      members: input.members ?? [],
      created_at: this.now(),
      submitted_at: null,
    };
    this.pursuits.set(pursuit.id, deepFreeze(pursuit));
    return pursuit;
  }

  getPursuit(id: PursuitId): Pursuit | undefined {
    return this.pursuits.get(id);
  }

  listPursuits(): readonly Pursuit[] {
    return [...this.pursuits.values()];
  }

  /**
   * General pursuit edit. Refuses `stage` — that field is the Orchestrator's
   * alone (CLAUDE.md: "Only the Orchestrator writes pursuit.stage").
   */
  updatePursuit(
    id: PursuitId,
    patch: Partial<Omit<Pursuit, "id" | "org_id" | "created_at" | "stage">>,
  ): Pursuit {
    if ("stage" in patch) {
      throw new GraphError(
        "pursuit.stage is written only through orchestrator().setStage",
      );
    }
    const current = this.require(this.pursuits.get(id), "Pursuit", id);
    const next = deepFreeze({ ...current, ...patch, id: current.id });
    this.pursuits.set(id, next);
    return next;
  }

  /** The only interface permitted to write pursuit.stage. */
  orchestrator(): OrchestratorScope {
    return {
      setStage: (pursuitId, target, opts) => {
        const current = this.require(
          this.pursuits.get(pursuitId),
          "Pursuit",
          pursuitId,
        );

        // Gate 1: themes must be human-locked before drafting starts.
        if (target === "drafting") {
          const hasLockedTheme = [...this.themes.values()].some(
            (t) => t.pursuit_id === pursuitId && t.status === "locked",
          );
          if (!hasLockedTheme) {
            throw new GraphError(
              "blocked: themes must be human-locked before drafting can start",
            );
          }
        }

        // Gate 2: export/submission requires an explicit human click.
        if (target === "submitted" && opts?.humanExportConfirmed !== true) {
          throw new GraphError(
            "blocked: export requires a human click (humanExportConfirmed)",
          );
        }

        const next = deepFreeze({
          ...current,
          stage: target,
          submitted_at:
            target === "submitted" ? this.now() : current.submitted_at,
        });
        this.pursuits.set(pursuitId, next);
        return next;
      },
    };
  }

  // -------------------------------------------------------------------------
  // IntakeSource
  // -------------------------------------------------------------------------

  addIntakeSource(input: {
    pursuit_id: PursuitId;
    kind: IntakeSourceKind;
    uri: string;
    parse_status?: ParseStatus;
  }): IntakeSource {
    const source: IntakeSource = {
      id: this.ids.mint("IntakeSource"),
      pursuit_id: input.pursuit_id,
      kind: input.kind,
      uri: input.uri,
      parse_status: input.parse_status ?? "pending",
    };
    this.intakeSources.set(source.id, deepFreeze(source));
    return source;
  }

  // -------------------------------------------------------------------------
  // Requirement + RequirementMapping
  // -------------------------------------------------------------------------

  addRequirement(input: {
    pursuit_id: PursuitId;
    source_ref: Requirement["source_ref"];
    kind: RequirementKind;
    text: string;
    priority: RequirementPriority;
  }): Requirement {
    const req: Requirement = {
      id: this.ids.mint("Requirement"),
      pursuit_id: input.pursuit_id,
      source_ref: input.source_ref,
      kind: input.kind,
      text: input.text,
      priority: input.priority,
    };
    this.requirements.set(req.id, deepFreeze(req));
    return req;
  }

  getRequirement(id: RequirementId): Requirement | undefined {
    return this.requirements.get(id);
  }

  addMapping(input: {
    requirement_id: RequirementId;
    outline_node_id: OutlineNodeId;
    created_by: RequirementMapping["created_by"];
    confirmed_by?: UserId | null;
  }): RequirementMapping {
    const mapping: RequirementMapping = {
      id: this.ids.mint("RequirementMapping"),
      requirement_id: input.requirement_id,
      outline_node_id: input.outline_node_id,
      created_by: input.created_by,
      confirmed_by: input.confirmed_by ?? null,
    };
    this.mappings.set(mapping.id, deepFreeze(mapping));
    return mapping;
  }

  removeMapping(id: RequirementMappingId): void {
    this.mappings.delete(id);
  }

  /**
   * Requirement.coverage_status — the computed value. Never stored, never
   * written by an agent; derived here from mappings, section status, and claim
   * verification.
   */
  coverageStatus(requirementId: RequirementId): CoverageStatus {
    this.require(this.requirements.get(requirementId), "Requirement", requirementId);
    return computeCoverageStatus(requirementId, this);
  }

  // -------------------------------------------------------------------------
  // OutlineNode — permanent identity
  // -------------------------------------------------------------------------

  addNode(input: {
    pursuit_id: PursuitId;
    parent_id?: OutlineNodeId | null;
    order: number;
    title: string;
    annotation?: string;
    page_budget?: number | null;
    assignee_id?: UserId | null;
    status?: OutlineNodeStatus;
  }): OutlineNode {
    const node: OutlineNode = {
      id: this.ids.mint("OutlineNode"),
      pursuit_id: input.pursuit_id,
      parent_id: input.parent_id ?? null,
      order: input.order,
      title: input.title,
      annotation: input.annotation ?? "",
      page_budget: input.page_budget ?? null,
      assignee_id: input.assignee_id ?? null,
      status: input.status ?? "empty",
    };
    this.nodes.set(node.id, deepFreeze(node));
    return node;
  }

  getNode(id: OutlineNodeId): OutlineNode | undefined {
    return this.nodes.get(id);
  }

  listNodes(pursuitId: PursuitId): readonly OutlineNode[] {
    return [...this.nodes.values()].filter((n) => n.pursuit_id === pursuitId);
  }

  /** Rename preserves id — the Word-sync contract survives a title change. */
  renameNode(id: OutlineNodeId, title: string): OutlineNode {
    return this.patchNode(id, { title });
  }

  /** Reorder/reparent preserve id — the contract survives structural moves. */
  reorderNode(
    id: OutlineNodeId,
    change: { order?: number; parent_id?: OutlineNodeId | null },
  ): OutlineNode {
    return this.patchNode(id, change);
  }

  setNodeStatus(id: OutlineNodeId, status: OutlineNodeStatus): OutlineNode {
    return this.patchNode(id, { status });
  }

  setNodeAnnotation(id: OutlineNodeId, annotation: string): OutlineNode {
    return this.patchNode(id, { annotation });
  }

  assignNode(id: OutlineNodeId, assignee_id: UserId | null): OutlineNode {
    return this.patchNode(id, { assignee_id });
  }

  /** Deleting retires the id forever; it can never be minted onto a new node. */
  deleteNode(id: OutlineNodeId): void {
    this.require(this.nodes.get(id), "OutlineNode", id);
    this.nodes.delete(id);
    const sectionId = this.sectionByNode.get(id);
    if (sectionId) {
      this.sectionByNode.delete(id);
      this.sections.delete(sectionId);
    }
    this.ids.retire(id);
  }

  private patchNode(
    id: OutlineNodeId,
    patch: Partial<Omit<OutlineNode, "id" | "pursuit_id">>,
  ): OutlineNode {
    const current = this.require(this.nodes.get(id), "OutlineNode", id);
    // id is spread last from `current` so no patch can ever change it.
    const next = deepFreeze({ ...current, ...patch, id: current.id });
    this.nodes.set(id, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Section + SectionRevision (content is revisions, never in-place edits)
  // -------------------------------------------------------------------------

  createSection(nodeId: OutlineNodeId): Section {
    this.require(this.nodes.get(nodeId), "OutlineNode", nodeId);
    if (this.sectionByNode.has(nodeId)) {
      throw new GraphError(`OutlineNode ${nodeId} already has a Section`);
    }
    const section: Section = {
      id: this.ids.mint("Section"),
      node_id: nodeId,
      current_revision_id: null,
      lock: null,
    };
    this.sections.set(section.id, deepFreeze(section));
    this.sectionByNode.set(nodeId, section.id);
    return section;
  }

  getSection(id: SectionId): Section | undefined {
    return this.sections.get(id);
  }

  sectionForNode(nodeId: OutlineNodeId): Section | undefined {
    const sectionId = this.sectionByNode.get(nodeId);
    return sectionId ? this.sections.get(sectionId) : undefined;
  }

  /**
   * The ONLY way section content changes: append a new immutable revision and
   * advance the section head. Prior revisions are never touched.
   *
   * `editedRanges` (spans, relative to the new content) drives claim staleness:
   * a claim whose anchor overlaps an edited range goes `stale`; claims elsewhere
   * keep their verdict. All surviving claims re-anchor to the new revision.
   */
  commitRevision(input: {
    section_id: SectionId;
    content: string;
    author: Authorship;
    generation_record_id?: SectionRevision["generation_record_id"];
    editedRanges?: readonly Span[];
    created_at?: string;
  }): SectionRevision {
    const section = this.require(
      this.sections.get(input.section_id),
      "Section",
      input.section_id,
    );

    const revision: SectionRevision = {
      id: this.ids.mint("SectionRevision"),
      section_id: section.id,
      parent_revision_id: section.current_revision_id,
      author: input.author,
      content: input.content,
      generation_record_id: input.generation_record_id ?? null,
      created_at: input.created_at ?? this.now(),
    };
    this.revisions.set(revision.id, deepFreeze(revision));

    // Advance the head. A whole new Section record — the old one is untouched.
    this.sections.set(
      section.id,
      deepFreeze({ ...section, current_revision_id: revision.id }),
    );

    this.reanchorClaims(section.id, revision.id, input.editedRanges ?? []);
    return revision;
  }

  getRevision(id: SectionRevisionId): SectionRevision | undefined {
    return this.revisions.get(id);
  }

  /** Full revision chain for a section, oldest first. */
  revisionHistory(sectionId: SectionId): readonly SectionRevision[] {
    return [...this.revisions.values()]
      .filter((r) => r.section_id === sectionId)
      .sort((a, b) => this.revisionDepth(a) - this.revisionDepth(b));
  }

  private revisionDepth(rev: SectionRevision): number {
    let depth = 0;
    let parent = rev.parent_revision_id;
    while (parent) {
      depth += 1;
      parent = this.revisions.get(parent)?.parent_revision_id ?? null;
    }
    return depth;
  }

  // -------------------------------------------------------------------------
  // WinTheme — human-only locking (Orchestrator's first gate)
  // -------------------------------------------------------------------------

  createTheme(input: {
    pursuit_id: PursuitId;
    kind: WinThemeKind;
    text: string;
    scope?: WinThemeScope;
  }): WinTheme {
    const theme: WinTheme = {
      id: this.ids.mint("WinTheme"),
      pursuit_id: input.pursuit_id,
      kind: input.kind,
      text: input.text,
      scope: input.scope ?? { kind: "pursuit" },
      status: "draft", // agents may only ever create drafts
      version: 1,
    };
    this.themes.set(theme.id, deepFreeze(theme));
    return theme;
  }

  getTheme(id: WinThemeId): WinTheme | undefined {
    return this.themes.get(id);
  }

  /**
   * Lock a theme. Human-only by construction: it requires a UserId and there is
   * no agent-facing lock path. Only locked themes condition generation, and
   * locking is the first human gate before drafting.
   */
  lockTheme(id: WinThemeId, _humanUserId: UserId): WinTheme {
    const current = this.require(this.themes.get(id), "WinTheme", id);
    const next = deepFreeze({ ...current, status: "locked" as const });
    this.themes.set(id, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Claim + Citation — verification_status is Verifier-only
  // -------------------------------------------------------------------------

  addClaim(input: {
    section_id: SectionId;
    anchor: Claim["anchor"];
    text: string;
  }): Claim {
    this.require(this.sections.get(input.section_id), "Section", input.section_id);
    const claim: Claim = {
      id: this.ids.mint("Claim"),
      section_id: input.section_id,
      anchor: input.anchor,
      text: input.text,
      verification_status: "pending", // drafting proposes; it never verifies
      verified_at: null,
      method: null,
    };
    this.claims.set(claim.id, deepFreeze(claim));
    const list = this.claimsBySection.get(input.section_id) ?? [];
    list.push(claim.id);
    this.claimsBySection.set(input.section_id, list);
    return claim;
  }

  getClaim(id: ClaimId): Claim | undefined {
    return this.claims.get(id);
  }

  claimsForSection(sectionId: SectionId): readonly Claim[] {
    return (this.claimsBySection.get(sectionId) ?? [])
      .map((id) => this.claims.get(id))
      .filter((c): c is Claim => c !== undefined);
  }

  /**
   * General claim edit. Refuses `verification_status` — only the Verifier writes
   * a verdict (CLAUDE.md: "written only by the Verifier").
   */
  updateClaim(
    id: ClaimId,
    patch: Partial<Omit<Claim, "id" | "section_id" | "verification_status" | "verified_at" | "method">>,
  ): Claim {
    if ("verification_status" in patch) {
      throw new GraphError(
        "claim.verification_status is written only through verifier().setVerificationStatus",
      );
    }
    const current = this.require(this.claims.get(id), "Claim", id);
    const next = deepFreeze({ ...current, ...patch, id: current.id });
    this.claims.set(id, next);
    return next;
  }

  /** The only interface permitted to write a verification verdict. */
  verifier(): VerifierScope {
    return {
      setVerificationStatus: (claimId, verdict, opts) => {
        const current = this.require(this.claims.get(claimId), "Claim", claimId);
        const next = deepFreeze({
          ...current,
          verification_status: verdict,
          verified_at: opts?.verified_at ?? this.now(),
          method: opts?.method ?? "entailment",
        });
        this.claims.set(claimId, next);
        return next;
      },
    };
  }

  addCitation(input: {
    claim_id: ClaimId;
    asset_id: Citation["asset_id"];
    passage_id: Citation["passage_id"];
    quote: string;
    locator: string;
  }): Citation {
    this.require(this.claims.get(input.claim_id), "Claim", input.claim_id);
    const citation: Citation = {
      id: this.ids.mint("Citation"),
      claim_id: input.claim_id,
      asset_id: input.asset_id,
      passage_id: input.passage_id,
      quote: input.quote,
      locator: input.locator,
    };
    this.citations.set(citation.id, deepFreeze(citation));
    return citation;
  }

  /**
   * Re-anchor a section's claims onto a new revision. Claims whose span overlaps
   * an edited range are invalidated to `stale`; others keep their verdict. This
   * is the store's own staleness write — the only non-Verifier path to the
   * field, and it only ever moves a claim to `stale`, never to a verdict.
   */
  private reanchorClaims(
    sectionId: SectionId,
    newRevisionId: SectionRevisionId,
    editedRanges: readonly Span[],
  ): void {
    for (const claimId of this.claimsBySection.get(sectionId) ?? []) {
      const claim = this.claims.get(claimId);
      if (!claim) continue;
      const hit = editedRanges.some((range) => overlaps(range, claim.anchor));
      const next = deepFreeze({
        ...claim,
        anchor: { ...claim.anchor, revision_id: newRevisionId },
        verification_status: hit ? ("stale" as const) : claim.verification_status,
        verified_at: hit ? null : claim.verified_at,
      });
      this.claims.set(claimId, next);
    }
  }

  // -------------------------------------------------------------------------
  // Library + provenance + snapshots (light; enough for grounding & audit)
  // -------------------------------------------------------------------------

  addAsset(input: Omit<Asset, "id">): Asset {
    const asset: Asset = { ...input, id: this.ids.mint("Asset") };
    this.assets.set(asset.id, deepFreeze(asset));
    return asset;
  }

  addPassage(input: Omit<Passage, "id">): Passage {
    const passage: Passage = { ...input, id: this.ids.mint("Passage") };
    this.passages.set(passage.id, deepFreeze(passage));
    return passage;
  }

  recordGeneration(input: {
    pursuit_id: PursuitId;
    agent: AgentName;
    inputs: GenerationInputs;
    output_revision_id?: SectionRevisionId | null;
    tokens?: number;
    cost_units?: number;
  }): GenerationRecord {
    const record: GenerationRecord = {
      id: this.ids.mint("GenerationRecord"),
      pursuit_id: input.pursuit_id,
      agent: input.agent,
      inputs: input.inputs,
      output_revision_id: input.output_revision_id ?? null,
      tokens: input.tokens ?? 0,
      cost_units: input.cost_units ?? 0,
      created_at: this.now(),
    };
    this.generationRecords.set(record.id, deepFreeze(record));
    return record;
  }

  createSnapshot(input: { pursuit_id: PursuitId; label: string }): PursuitSnapshot {
    const snapshot: PursuitSnapshot = {
      id: this.ids.mint("PursuitSnapshot"),
      pursuit_id: input.pursuit_id,
      label: input.label,
      created_at: this.now(),
    };
    this.snapshots.set(snapshot.id, deepFreeze(snapshot));
    return snapshot;
  }

  // -------------------------------------------------------------------------
  // CoverageView implementation
  // -------------------------------------------------------------------------

  mappingsForRequirement(requirementId: RequirementId): readonly RequirementMapping[] {
    return [...this.mappings.values()].filter(
      (m) => m.requirement_id === requirementId,
    );
  }

  node(nodeId: OutlineNodeId): OutlineNode | undefined {
    return this.nodes.get(nodeId);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private require<T>(value: T | undefined, kind: string, id: string): T {
    if (value === undefined) {
      throw new GraphError(`${kind} not found: ${id}`);
    }
    return value;
  }
}

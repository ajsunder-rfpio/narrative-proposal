import type { GraphStore } from "../graph/store";
import type {
  Citation,
  Claim,
  GenerationRecord,
  OutlineNode,
  RequirementId,
  SectionRevision,
  StyleGuide,
  WinTheme,
} from "../graph/types";
import type { LLM, LLMMessage } from "./fake-llm";
import type { RetrievedPassage, Retriever } from "./retrieval";

// ---------------------------------------------------------------------------
// Drafting agent (agent-definitions.md #5)
//
// Writes prose for ONE node per call, conditioned on the node annotation, locked
// themes, style guide, and retrieval over the library. Every factual assertion
// sourced from retrieval becomes a Claim with Citations to specific passages.
// When retrieval yields nothing for a needed proof point, it writes the explicit
// gap marker instead of smoothing prose over the hole. It NEVER verifies its own
// claims and NEVER writes verification_status — it has no verifier handle.
// ---------------------------------------------------------------------------

/** Spec-mandated marker; smooth prose over missing evidence is forbidden. */
export const GAP_MARKER = "[no supporting evidence found in library]";

/** The Drafting LLM's output contract: an ordered list of prose segments. */
export type DraftSegment =
  | { kind: "text"; text: string }
  | { kind: "claim"; text: string; quote: string; proof_point?: string }
  | { kind: "gap"; proof_point: string };

export interface DraftLLMOutput {
  segments: DraftSegment[];
}

export interface DraftInput {
  readonly node: OutlineNode;
  /** Only locked themes condition generation; callers pass the locked set. */
  readonly lockedThemes?: readonly WinTheme[];
  readonly styleGuide?: StyleGuide | null;
  readonly requirementIds?: readonly RequirementId[];
  readonly promptTemplateVersion: string;
  readonly model: string;
  readonly retrievalLimit?: number;
}

export interface DraftResult {
  readonly revision: SectionRevision;
  readonly claims: readonly Claim[];
  readonly citations: readonly Citation[];
  readonly generation: GenerationRecord;
  /** Proof points that had no grounding and were gap-marked in the prose. */
  readonly gaps: readonly string[];
  readonly retrieved: readonly RetrievedPassage[];
}

export function parseDraftOutput(text: string): DraftLLMOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Drafting LLM returned non-JSON output");
  }
  const segments = (parsed as { segments?: unknown }).segments;
  if (!Array.isArray(segments)) {
    throw new Error("Drafting LLM output missing a segments array");
  }
  for (const seg of segments) {
    const kind = (seg as { kind?: unknown }).kind;
    if (kind !== "text" && kind !== "claim" && kind !== "gap") {
      throw new Error(`Drafting LLM output has an unknown segment kind: ${String(kind)}`);
    }
  }
  return { segments: segments as DraftSegment[] };
}

export class DraftingAgent {
  constructor(
    private readonly deps: {
      store: GraphStore;
      llm: LLM;
      retriever: Retriever;
    },
  ) {}

  async draft(input: DraftInput): Promise<DraftResult> {
    const { store, llm, retriever } = this.deps;
    const { node } = input;
    const lockedThemes = input.lockedThemes ?? [];
    const styleGuide = input.styleGuide ?? null;

    // Leaf gets a Section (one-to-one). Reuse an existing one if present.
    const section =
      store.sectionForNode(node.id) ?? store.createSection(node.id);

    // Retrieve evidence for this node.
    const query = `${node.title} ${node.annotation}`.trim();
    const retrieved = retriever.retrieve(query, { limit: input.retrievalLimit });

    // Ask the model for a segmented draft.
    const messages = buildDraftMessages(node, lockedThemes, styleGuide, retrieved);
    const output = parseDraftOutput(
      (await llm.complete({ messages, purpose: "draft" })).text,
    );

    // Assemble prose, binding each claim segment to a retrieved passage. A claim
    // whose quote is not verbatim in any retrieved passage has no grounding, so
    // it becomes a gap marker — never a fabricated citation.
    let content = "";
    const pendingClaims: {
      text: string;
      start: number;
      end: number;
      passageId: RetrievedPassage["passage"]["id"];
      assetId: RetrievedPassage["asset"]["id"];
      quote: string;
      locator: string;
    }[] = [];
    const gaps: string[] = [];

    for (const seg of output.segments) {
      if (seg.kind === "text") {
        content += seg.text;
        continue;
      }
      if (seg.kind === "gap") {
        content += GAP_MARKER;
        gaps.push(seg.proof_point);
        continue;
      }
      // claim segment
      const match = retrieved.find((r) => r.passage.text.includes(seg.quote));
      if (!match) {
        content += GAP_MARKER;
        gaps.push(seg.proof_point ?? seg.text);
        continue;
      }
      const start = content.length;
      content += seg.text;
      pendingClaims.push({
        text: seg.text,
        start,
        end: content.length,
        passageId: match.passage.id,
        assetId: match.asset.id,
        quote: seg.quote,
        locator: match.passage.locator,
      });
    }

    // Provenance first (with a null output link), then the immutable revision,
    // then close the link. See GraphStore.setGenerationOutput.
    const generation0 = store.recordGeneration({
      pursuit_id: node.pursuit_id,
      agent: "drafting",
      inputs: {
        node_id: node.id,
        requirement_ids: input.requirementIds ?? [],
        theme_versions: lockedThemes.map((t) => ({
          theme_id: t.id,
          version: t.version,
        })),
        style_guide_version: styleGuide?.version ?? null,
        retrieved_passage_ids: retrieved.map((r) => r.passage.id),
        prompt_template_version: input.promptTemplateVersion,
        model: input.model,
      },
      output_revision_id: null,
    });

    const revision = store.commitRevision({
      section_id: section.id,
      content,
      author: { by: "agent", agent: "drafting" },
      generation_record_id: generation0.id,
    });

    const generation = store.setGenerationOutput(generation0.id, revision.id);

    // Claims + Citations. addClaim sets verification_status = "pending"; the
    // Drafting agent never touches that field — the Verifier owns it.
    const claims: Claim[] = [];
    const citations: Citation[] = [];
    for (const pc of pendingClaims) {
      const claim = store.addClaim({
        section_id: section.id,
        anchor: { revision_id: revision.id, start: pc.start, end: pc.end },
        text: pc.text,
      });
      claims.push(claim);
      citations.push(
        store.addCitation({
          claim_id: claim.id,
          asset_id: pc.assetId,
          passage_id: pc.passageId,
          quote: pc.quote,
          locator: pc.locator,
        }),
      );
    }

    return { revision, claims, citations, generation, gaps, retrieved };
  }
}

function buildDraftMessages(
  node: OutlineNode,
  lockedThemes: readonly WinTheme[],
  styleGuide: StyleGuide | null,
  retrieved: readonly RetrievedPassage[],
): LLMMessage[] {
  const systemParts = [
    "You are the Drafting agent. Write prose for exactly one outline node.",
    "Return JSON: { segments: [{kind:'text',text} | {kind:'claim',text,quote,proof_point} | {kind:'gap',proof_point}] }.",
    "Every library-sourced assertion must be a claim whose quote is verbatim from a provided passage.",
    "If you lack evidence for a needed proof point, emit a gap segment. Never write around the hole.",
  ];
  if (styleGuide) systemParts.push(`Style guide (v${styleGuide.version}):\n${styleGuide.content}`);
  if (lockedThemes.length) {
    systemParts.push(
      "Locked win themes:\n" +
        lockedThemes.map((t) => `- (${t.kind}) ${t.text}`).join("\n"),
    );
  }

  const passageBlock = retrieved.length
    ? retrieved
        .map((r) => `[${r.passage.id}] (${r.passage.locator}) ${r.passage.text}`)
        .join("\n")
    : "(no passages retrieved)";

  return [
    { role: "system", content: systemParts.join("\n\n") },
    {
      role: "user",
      content:
        `Node: ${node.title}\nAnnotation: ${node.annotation}\n\n` +
        `Retrieved passages:\n${passageBlock}`,
    },
  ];
}

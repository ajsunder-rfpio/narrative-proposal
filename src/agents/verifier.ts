import type { GraphStore } from "../graph/store.ts";
import type { Claim, ClaimId, Passage } from "../graph/types.ts";
import type { LLM, LLMMessage } from "./fake-llm.ts";

// ---------------------------------------------------------------------------
// Verifier agent (agent-definitions.md #6)
//
// Reads ONLY claims and their cited passages — never themes, style, or prose.
// Two layers:
//   1. Code check: every Citation.quote must appear verbatim in its cited
//      passage. A miss fails the claim outright, with no LLM call.
//   2. Entailment: for claims that clear the code check, one LLM call asks
//      whether the passages actually support the claim text.
// Sole writer of verification_status. Never rewrites a claim, drops a citation,
// or touches prose — a failed claim stays in the text, flagged.
// ---------------------------------------------------------------------------

export type VerifyLayer = "code" | "entailment";

export interface VerifyResult {
  readonly claimId: ClaimId;
  readonly status: "verified" | "unsupported";
  /** Which layer decided it. */
  readonly layer: VerifyLayer;
  readonly llmCalled: boolean;
  readonly reason: string;
}

export interface EntailmentLLMOutput {
  entailed: boolean;
  rationale?: string;
}

/** Parse the entailment call. Accepts {entailed:boolean} JSON, or a bare token. */
export function parseEntailment(text: string): boolean {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as EntailmentLLMOutput;
    if (typeof parsed.entailed === "boolean") return parsed.entailed;
  } catch {
    // fall through to token parsing
  }
  const token = trimmed.toLowerCase();
  if (["verified", "supported", "entailed", "true", "yes"].includes(token)) return true;
  if (["unsupported", "unverified", "false", "no"].includes(token)) return false;
  throw new Error(`Verifier could not parse entailment output: ${text}`);
}

export class VerifierAgent {
  constructor(
    private readonly deps: {
      store: GraphStore;
      llm: LLM;
      method?: string;
    },
  ) {}

  async verify(claimId: ClaimId): Promise<VerifyResult> {
    const { store, llm } = this.deps;
    const method = this.deps.method ?? "entailment";

    const claim = store.getClaim(claimId);
    if (!claim) throw new Error(`Verifier: claim not found: ${claimId}`);

    const citations = store.citationsForClaim(claimId);

    // A library-sourced claim with no citation cannot be grounded at all.
    if (citations.length === 0) {
      return this.write(claimId, "unsupported", "code", false, "no citations", "quote-check");
    }

    // Layer 1 — verbatim quote check. No LLM call.
    const citedPassages: Passage[] = [];
    for (const citation of citations) {
      const passage = store.getPassage(citation.passage_id);
      if (!passage || !passage.text.includes(citation.quote)) {
        return this.write(
          claimId,
          "unsupported",
          "code",
          false,
          `quote not verbatim in passage ${citation.passage_id}`,
          "quote-check",
        );
      }
      citedPassages.push(passage);
    }

    // Layer 2 — entailment. The only inputs are the claim text and its passages.
    const messages = buildEntailmentMessages(claim, citedPassages);
    const entailed = parseEntailment(
      (await llm.complete({ messages, purpose: "verify" })).text,
    );

    return this.write(
      claimId,
      entailed ? "verified" : "unsupported",
      "entailment",
      true,
      entailed ? "passages entail the claim" : "passages do not entail the claim",
      method,
    );
  }

  private write(
    claimId: ClaimId,
    status: "verified" | "unsupported",
    layer: VerifyLayer,
    llmCalled: boolean,
    reason: string,
    method: string,
  ): VerifyResult {
    this.deps.store.verifier().setVerificationStatus(claimId, status, { method });
    return { claimId, status, layer, llmCalled, reason };
  }
}

function buildEntailmentMessages(
  claim: Claim,
  passages: readonly Passage[],
): LLMMessage[] {
  return [
    {
      role: "system",
      content:
        "You are the Verifier. Decide only whether the cited passages entail the claim. " +
        "You see nothing else — not the surrounding prose, themes, or style. " +
        'Return JSON: { "entailed": true|false }.',
    },
    {
      role: "user",
      content:
        `Claim: ${claim.text}\n\nCited passages:\n` +
        passages.map((p) => `[${p.id}] ${p.text}`).join("\n"),
    },
  ];
}

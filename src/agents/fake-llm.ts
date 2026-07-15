// Fake-LLM test harness.
//
// No agent logic lives here yet — this is the scaffolding the `agents` suite
// will build on. CLAUDE.md requires the agent tests to run against fixtures
// "incl. a deliberately hallucinating fake LLM", so the harness ships two fakes:
// a scripted one for happy-path contracts, and a hallucinating one that
// fabricates ungrounded facts, so future Verifier/Drafting contracts can prove
// they catch and flag hallucination rather than trusting the model.

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LLMRequest {
  readonly messages: readonly LLMMessage[];
  /** Optional tag the harness can key a scripted response off of. */
  readonly purpose?: string;
}

export interface LLMResponse {
  readonly text: string;
}

/** The single seam every agent will depend on. Real and fake share it. */
export interface LLM {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/** Records every request, so tests can assert what an agent actually sent. */
export abstract class RecordingLLM implements LLM {
  readonly calls: LLMRequest[] = [];

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request);
    return this.respond(request);
  }

  protected abstract respond(request: LLMRequest): Promise<LLMResponse>;
}

/**
 * Deterministic scripted fake. Give it either a queue of replies (consumed in
 * order) or a matcher keyed on request.purpose. Missing scripts throw loudly so
 * a test never silently passes on an unexpected call.
 */
export class ScriptedLLM extends RecordingLLM {
  private queue: string[];
  private readonly byPurpose: Record<string, string>;

  constructor(script: { queue?: string[]; byPurpose?: Record<string, string> } = {}) {
    super();
    this.queue = [...(script.queue ?? [])];
    this.byPurpose = script.byPurpose ?? {};
  }

  protected async respond(request: LLMRequest): Promise<LLMResponse> {
    if (request.purpose && request.purpose in this.byPurpose) {
      return { text: this.byPurpose[request.purpose] };
    }
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(
        `ScriptedLLM: no scripted response for request${
          request.purpose ? ` (purpose=${request.purpose})` : ""
        }`,
      );
    }
    return { text: next };
  }
}

/**
 * Deliberately hallucinating fake. It ignores the prompt and returns a confident
 * fabricated *draft*: a claim whose supporting quote is a real snippet (so
 * Drafting will ground and cite it) but whose asserted text wildly overstates
 * that snippet — the exact failure mode the Verifier's entailment check exists
 * to catch. Agent contract tests use it to prove the pipeline never trusts model
 * output on its own: the fabricated claim survives drafting but must end up
 * flagged unsupported, with its text still present in the revision.
 *
 * Emits the Drafting LLM protocol (a `{ segments: [...] }` object) so it can
 * stand in as the drafting model directly.
 */
export class HallucinatingLLM extends RecordingLLM {
  /** A snippet the test seeds verbatim into a fixture passage, so the fabricated
   *  claim clears Drafting's grounding check and the Verifier's quote check. */
  static readonly QUOTE = "field trials began";

  /** The overstated assertion the snippet does NOT actually support. */
  static readonly FABRICATION =
    "Our platform was deployed to 4,000 sites in 2019, cutting costs 63%.";

  protected async respond(request: LLMRequest): Promise<LLMResponse> {
    // Still ignores the actual prompt — it fabricates regardless of input — but
    // fabricates in the shape the calling agent expects, so it can stand in for
    // any model in the pipeline.
    if (request.purpose === "intake") {
      // A fact citing a source that doesn't exist, with a quote absent from any
      // real source: the Intake agent must drop it, never store it.
      return {
        text: JSON.stringify({
          facts: [
            {
              key: "customer",
              value: HallucinatingLLM.FABRICATION,
              source_id: "IntakeSource_hallucinated",
              quote: HallucinatingLLM.QUOTE,
            },
          ],
        }),
      };
    }
    return {
      text: JSON.stringify({
        segments: [
          { kind: "text", text: "Our track record speaks for itself. " },
          {
            kind: "claim",
            text: HallucinatingLLM.FABRICATION,
            quote: HallucinatingLLM.QUOTE,
          },
        ],
      }),
    };
  }
}

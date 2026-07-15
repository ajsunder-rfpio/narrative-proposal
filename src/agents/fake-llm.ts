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
 * Deliberately hallucinating fake. It ignores the prompt and returns confident,
 * fabricated assertions that are NOT grounded in any provided passage. Agent
 * contract tests use it to prove the pipeline never trusts model output on its
 * own: drafting claims from this fake must end up unverified/flagged, and the
 * Verifier must reject them.
 */
export class HallucinatingLLM extends RecordingLLM {
  constructor(
    private readonly fabrication = "Acme deployed our platform to 4,000 sites in 2019, cutting costs 63%.",
  ) {
    super();
  }

  protected async respond(_request: LLMRequest): Promise<LLMResponse> {
    return { text: this.fabrication };
  }
}

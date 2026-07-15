import type { GraphStore } from "../graph/store.ts";
import type {
  ContextField,
  ContextFact,
  ContextFieldKey,
  GenerationRecord,
  IntakeSource,
  PursuitContext,
  PursuitId,
} from "../graph/types.ts";
import type { LLM, LLMMessage } from "./fake-llm.ts";

// ---------------------------------------------------------------------------
// Intake agent (agent-definitions.md #2)
//
// Turns raw sources (transcript, CRM extract, capture notes) into structured
// pursuit context. Every extracted fact carries a locator to its source. A field
// it can't find is reported not_found — explicitly, never omitted. It invents
// nothing: a proposed fact whose quote is not verbatim in its cited source is
// dropped, never stored as fact. No requirements parsing at MVP.
// ---------------------------------------------------------------------------

export const CONTEXT_FIELD_KEYS: readonly ContextFieldKey[] = [
  "customer",
  "problem",
  "scope",
  "budget_signals",
  "stakeholders",
  "competitive_mentions",
];

/** How the agent reads a source's content (the object model stores only a uri). */
export interface SourceContentReader {
  read(source: IntakeSource): string;
}

/** Fixture reader: source id -> raw text. */
export class FixtureSourceReader implements SourceContentReader {
  constructor(private readonly contents: Record<string, string>) {}
  read(source: IntakeSource): string {
    return this.contents[source.id] ?? "";
  }
}

/** The Intake LLM's output contract. */
export interface RawIntakeFact {
  key: string;
  value: string;
  source_id: string;
  quote: string;
}

export function parseIntakeOutput(text: string): RawIntakeFact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Intake LLM returned non-JSON output");
  }
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) {
    throw new Error("Intake LLM output missing a facts array");
  }
  return facts.map((f) => {
    const r = f as Record<string, unknown>;
    return {
      key: String(r.key ?? ""),
      value: String(r.value ?? ""),
      source_id: String(r.source_id ?? ""),
      quote: String(r.quote ?? ""),
    };
  });
}

export interface IntakeInput {
  readonly pursuit_id: PursuitId;
  readonly sources: readonly IntakeSource[];
  readonly reader: SourceContentReader;
  readonly promptTemplateVersion?: string;
  readonly model?: string;
}

export interface IntakeResult {
  readonly context: PursuitContext;
  readonly generation: GenerationRecord;
  /** Proposed facts that failed grounding and were NOT stored. */
  readonly dropped: readonly RawIntakeFact[];
}

export class IntakeAgent {
  constructor(private readonly deps: { store: GraphStore; llm: LLM }) {}

  async parse(input: IntakeInput): Promise<IntakeResult> {
    const { store, llm } = this.deps;

    const sourcesById = new Map(input.sources.map((s) => [s.id, s]));
    const contents = new Map(
      input.sources.map((s) => [s.id, input.reader.read(s)]),
    );

    const messages = buildIntakeMessages(input.sources, contents);
    const raw = parseIntakeOutput(
      (await llm.complete({ messages, purpose: "intake" })).text,
    );

    // Ground every proposed fact against the cited source. No quote match => the
    // fact is not from a source => dropped. This is the "invents nothing" gate.
    const accepted: ContextFact[] = [];
    const dropped: RawIntakeFact[] = [];
    for (const fact of raw) {
      const key = fact.key as ContextFieldKey;
      const source = sourcesById.get(
        fact.source_id as IntakeSource["id"],
      );
      const content = source ? contents.get(source.id) ?? "" : "";
      const grounded =
        CONTEXT_FIELD_KEYS.includes(key) &&
        source !== undefined &&
        fact.quote.length > 0 &&
        content.includes(fact.quote);
      if (!grounded) {
        dropped.push(fact);
        continue;
      }
      accepted.push({
        key,
        value: fact.value,
        source: { source_id: source!.id, locator: fact.quote },
      });
    }

    const generation = store.recordGeneration({
      pursuit_id: input.pursuit_id,
      agent: "intake",
      inputs: {
        node_id: null,
        requirement_ids: [],
        theme_versions: [],
        style_guide_version: null,
        retrieved_passage_ids: [],
        prompt_template_version: input.promptTemplateVersion ?? "intake-v1",
        model: input.model ?? "fake-model",
      },
      output_revision_id: null,
    });

    // Every field gets an entry; found only if it has at least one grounded fact.
    const fields: ContextField[] = CONTEXT_FIELD_KEYS.map((key) => {
      const facts = accepted.filter((a) => a.key === key);
      return {
        key,
        status: facts.length > 0 ? "found" : "not_found",
        facts,
      };
    });

    const context: PursuitContext = {
      pursuit_id: input.pursuit_id,
      fields,
      generation_record_id: generation.id,
    };
    store.setPursuitContext(context);

    return { context, generation, dropped };
  }
}

function buildIntakeMessages(
  sources: readonly IntakeSource[],
  contents: ReadonlyMap<string, string>,
): LLMMessage[] {
  const sourceBlock = sources
    .map((s) => `[${s.id}] (${s.kind})\n${contents.get(s.id) ?? ""}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You are the Intake agent. Extract structured pursuit context: " +
        `${CONTEXT_FIELD_KEYS.join(", ")}. ` +
        "Return JSON: { facts: [{key, value, source_id, quote}] }, where quote is " +
        "verbatim text copied from the cited source. Do not parse requirements. " +
        "If you cannot find a field in the sources, omit it — never guess.",
    },
    { role: "user", content: `Sources:\n${sourceBlock}` },
  ];
}

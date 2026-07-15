import type { GraphStore } from "../graph/store";
import type {
  GenerationRecord,
  OutlineNodeId,
  PursuitContext,
  PursuitId,
  WinTheme,
  WinThemeKind,
  WinThemeScope,
} from "../graph/types";
import type { LLM, LLMMessage } from "./fake-llm";

// ---------------------------------------------------------------------------
// Theme agent (agent-definitions.md #4)
//
// Drafts win themes, discriminators, and ghosting angles from intake context.
// Writes WinTheme records, ALWAYS status draft (the graph store enforces this —
// createTheme cannot produce anything else). Never locks a theme (human-only).
// Never overwrites a human-edited theme: it has no update path at all, so
// regeneration can only ever create new drafts alongside the existing ones.
// ---------------------------------------------------------------------------

export interface RawTheme {
  kind: WinThemeKind;
  text: string;
  scope?: "pursuit" | { node_ids: string[] };
}

export function parseThemeOutput(text: string): RawTheme[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Theme LLM returned non-JSON output");
  }
  const themes = (parsed as { themes?: unknown }).themes;
  if (!Array.isArray(themes)) {
    throw new Error("Theme LLM output missing a themes array");
  }
  return themes.map((t) => {
    const r = t as Record<string, unknown>;
    const kind = String(r.kind ?? "theme") as WinThemeKind;
    const scope = r.scope as RawTheme["scope"] | undefined;
    return { kind, text: String(r.text ?? ""), scope };
  });
}

function toScope(scope: RawTheme["scope"]): WinThemeScope {
  if (scope && typeof scope === "object" && "node_ids" in scope) {
    return { kind: "nodes", node_ids: scope.node_ids as OutlineNodeId[] };
  }
  return { kind: "pursuit" };
}

export interface ThemeInput {
  readonly pursuit_id: PursuitId;
  readonly context: PursuitContext;
  readonly promptTemplateVersion?: string;
  readonly model?: string;
}

export interface ThemeResult {
  readonly themes: readonly WinTheme[];
  readonly generation: GenerationRecord;
}

export class ThemeAgent {
  constructor(private readonly deps: { store: GraphStore; llm: LLM }) {}

  async draft(input: ThemeInput): Promise<ThemeResult> {
    const { store, llm } = this.deps;

    const messages = buildThemeMessages(input.context);
    const proposed = parseThemeOutput(
      (await llm.complete({ messages, purpose: "theme" })).text,
    );

    const generation = store.recordGeneration({
      pursuit_id: input.pursuit_id,
      agent: "theme",
      inputs: {
        node_id: null,
        requirement_ids: [],
        theme_versions: [],
        style_guide_version: null,
        retrieved_passage_ids: [],
        prompt_template_version: input.promptTemplateVersion ?? "theme-v1",
        model: input.model ?? "fake-model",
      },
      output_revision_id: null,
    });

    // createTheme always yields status "draft" — the agent never locks, never
    // edits an existing theme. Regeneration simply adds more drafts.
    const themes = proposed.map((t) =>
      store.createTheme({
        pursuit_id: input.pursuit_id,
        kind: t.kind,
        text: t.text,
        scope: toScope(t.scope),
      }),
    );

    return { themes, generation };
  }
}

function buildThemeMessages(context: PursuitContext): LLMMessage[] {
  const contextBlock = context.fields
    .map(
      (f) =>
        `${f.key}: ${
          f.status === "found"
            ? f.facts.map((fact) => fact.value).join("; ")
            : "(not found)"
        }`,
    )
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You are the Theme agent. Draft win themes, discriminators, and ghosting " +
        "angles from the intake context and competitive mentions. " +
        "Return JSON: { themes: [{kind: 'theme'|'discriminator'|'ghost', text, scope?}] }. " +
        "Do not lock themes; that is a human action.",
    },
    { role: "user", content: `Intake context:\n${contextBlock}` },
  ];
}

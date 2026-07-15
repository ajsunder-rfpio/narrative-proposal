import { GraphError, type GraphStore } from "../graph/store";
import type {
  IntakeSource,
  OutlineNode,
  PursuitContext,
  PursuitId,
  PursuitStage,
  StyleGuide,
  WinTheme,
} from "../graph/types";
import type { IntakeAgent, SourceContentReader } from "./intake";
import type { OutlineAgent, OutlineTemplate } from "./outline";
import type { ThemeAgent } from "./theme";

// ---------------------------------------------------------------------------
// Orchestrator (agent-definitions.md #1)
//
// The stage machine over the existing human gates. It sequences intake ->
// outline -> themes -> drafting, invokes the agents, and owns ALL pursuit.stage
// writes (via the store's orchestrator scope). It has NO content-generation path
// of any kind: no LLM, no retriever, no calls that write sections, revisions,
// claims, nodes, or themes. It only delegates and moves the stage. The first
// human gate (themes must be human-locked before drafting) is enforced by the
// store; the Orchestrator surfaces the block rather than working around it.
// ---------------------------------------------------------------------------

export interface OrchestratorRunInput {
  readonly pursuit_id: PursuitId;
  readonly sources: readonly IntakeSource[];
  readonly reader: SourceContentReader;
  readonly template: OutlineTemplate;
  readonly styleGuide?: StyleGuide | null;
  readonly promptTemplateVersion?: string;
  readonly model?: string;
}

export interface AdvanceResult {
  readonly advanced: boolean;
  /** The gate message when blocked; null when advanced. */
  readonly gate: string | null;
}

export interface OrchestratorRunResult {
  readonly stage: PursuitStage;
  readonly stagesVisited: readonly PursuitStage[];
  readonly context: PursuitContext;
  readonly nodes: readonly OutlineNode[];
  readonly themes: readonly WinTheme[];
  /** Non-null when the run halted at the themes-locked gate before drafting. */
  readonly blockedGate: string | null;
}

export class Orchestrator {
  constructor(
    private readonly deps: {
      store: GraphStore;
      intake: IntakeAgent;
      outline: OutlineAgent;
      theme: ThemeAgent;
    },
  ) {}

  /**
   * Drive intake -> outline -> themes, then attempt the drafting transition. The
   * store's gate blocks drafting until a human locks a theme, so a fresh run
   * halts at the gate with stage still `outline`.
   */
  async run(input: OrchestratorRunInput): Promise<OrchestratorRunResult> {
    const { store, intake, outline, theme } = this.deps;
    const stagesVisited: PursuitStage[] = [];

    const start = store.getPursuit(input.pursuit_id);
    if (!start) throw new Error(`Orchestrator: pursuit not found: ${input.pursuit_id}`);
    stagesVisited.push(start.stage); // "intake" for a fresh pursuit

    const intakeRes = await intake.parse({
      pursuit_id: input.pursuit_id,
      sources: input.sources,
      reader: input.reader,
      promptTemplateVersion: input.promptTemplateVersion,
      model: input.model,
    });

    // Stage write #1 — the Orchestrator owns this, not the agents.
    store.orchestrator().setStage(input.pursuit_id, "outline");
    stagesVisited.push("outline");

    const outlineRes = await outline.generate({
      pursuit_id: input.pursuit_id,
      context: intakeRes.context,
      template: input.template,
      styleGuide: input.styleGuide ?? null,
      promptTemplateVersion: input.promptTemplateVersion,
      model: input.model,
    });

    // Themes are drafted while still in the outline stage (there is no dedicated
    // "themes" stage in the pursuit machine).
    const themeRes = await theme.draft({
      pursuit_id: input.pursuit_id,
      context: intakeRes.context,
      promptTemplateVersion: input.promptTemplateVersion,
      model: input.model,
    });

    const advance = this.tryAdvanceToDrafting(input.pursuit_id);
    if (advance.advanced) stagesVisited.push("drafting");

    return {
      stage: store.getPursuit(input.pursuit_id)!.stage,
      stagesVisited,
      context: intakeRes.context,
      nodes: outlineRes.nodes,
      themes: themeRes.themes,
      blockedGate: advance.gate,
    };
  }

  /**
   * Attempt the intake/outline -> drafting transition. Returns the gate message
   * instead of throwing when the human-lock gate blocks it.
   */
  tryAdvanceToDrafting(pursuitId: PursuitId): AdvanceResult {
    try {
      this.deps.store.orchestrator().setStage(pursuitId, "drafting");
      return { advanced: true, gate: null };
    } catch (err) {
      if (err instanceof GraphError) return { advanced: false, gate: err.message };
      throw err;
    }
  }
}

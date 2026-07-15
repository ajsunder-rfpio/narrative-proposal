import type { GraphStore } from "../graph/store.ts";
import type {
  EvaluatorFinding,
  EvaluatorReport,
  FindingSeverity,
  GenerationRecord,
  PursuitSnapshot,
  ReviewAnchor,
  SnapshotTheme,
} from "../graph/types.ts";
import type { LLM, LLMMessage } from "./fake-llm.ts";

// ---------------------------------------------------------------------------
// Evaluator agent (agent-definitions.md #7)
//
// Reads a PursuitSnapshot (plus the locked themes and claim verdicts frozen into
// it) and emits an EvaluatorReport. MVP finding kinds: unsupported_claim,
// repetition, theme_gap, coherence — each anchored to a node or claim, with a
// severity. It CONSUMES the Verifier's verdicts and never re-verifies. Its only
// write is the report; it touches no other graph state.
//
//   unsupported_claim — code: read the frozen verdict, no verification call.
//   repetition        — code: near-duplicate passages across sections.
//   theme_gap         — LLM: is a locked theme reflected in its scoped section?
//   coherence         — LLM: does the assembled draft hang together?
//
// No scoring against evaluation criteria at MVP (there are none), so `scores` is
// always empty. The report shape is identical whether or not criteria exist —
// the federal fast-follow only fills `scores` in, it changes no format.
// ---------------------------------------------------------------------------

const REPETITION_THRESHOLD = 0.8;

export interface EvaluatorInput {
  readonly snapshot: PursuitSnapshot;
  readonly promptTemplateVersion?: string;
  readonly model?: string;
}

export interface EvaluatorResult {
  readonly report: EvaluatorReport;
  readonly generation: GenerationRecord;
}

// --- LLM output contracts --------------------------------------------------

export interface ThemeGapOutput {
  covered: boolean;
  detail?: string;
}

export function parseThemeGap(text: string): ThemeGapOutput {
  const parsed = JSON.parse(text) as ThemeGapOutput;
  if (typeof parsed.covered !== "boolean") {
    throw new Error("theme_gap output must include a boolean `covered`");
  }
  return parsed;
}

export interface CoherenceIssue {
  node_id?: string;
  detail: string;
  severity?: FindingSeverity;
}
export interface CoherenceOutput {
  issues: CoherenceIssue[];
}

export function parseCoherence(text: string): CoherenceOutput {
  const parsed = JSON.parse(text) as CoherenceOutput;
  if (!Array.isArray(parsed.issues)) {
    throw new Error("coherence output must include an `issues` array");
  }
  return parsed;
}

export class EvaluatorAgent {
  constructor(private readonly deps: { store: GraphStore; llm: LLM }) {}

  async evaluate(input: EvaluatorInput): Promise<EvaluatorResult> {
    const { store } = this.deps;
    const { snapshot } = input;

    const findings: EvaluatorFinding[] = [];

    // 1. unsupported_claim — pure read of the frozen verdict. No LLM, no verifier.
    for (const claim of snapshot.claims) {
      if (claim.verification_status === "unsupported") {
        findings.push({
          kind: "unsupported_claim",
          anchor: { kind: "claim", claim_id: claim.claim_id },
          detail: `Claim "${claim.text}" failed verification and remains unsupported.`,
          severity: "critical",
        });
      }
    }

    // 2. repetition — code-level near-duplicate detection across sections.
    findings.push(...detectRepetition(snapshot));

    // 3. theme_gap — LLM, for each locked theme against its scope.
    for (const theme of snapshot.themes) {
      if (theme.status !== "locked") continue;
      findings.push(...(await this.themeGap(theme, snapshot)));
    }

    // 4. coherence — LLM, over the assembled draft.
    findings.push(...(await this.coherence(snapshot)));

    const generation = store.recordGeneration({
      pursuit_id: snapshot.pursuit_id,
      agent: "evaluator",
      inputs: {
        node_id: null,
        requirement_ids: [],
        theme_versions: snapshot.themes
          .filter((t) => t.status === "locked")
          .map((t) => ({ theme_id: t.theme_id, version: t.version })),
        style_guide_version: null,
        retrieved_passage_ids: [],
        prompt_template_version: input.promptTemplateVersion ?? "evaluator-v1",
        model: input.model ?? "fake-model",
      },
      output_revision_id: null,
    });

    // The Evaluator's ONE write. `scores` is empty at MVP (no criteria).
    const report = store.addEvaluatorReport({
      pursuit_id: snapshot.pursuit_id,
      snapshot_id: snapshot.id,
      findings,
      scores: [],
    });

    return { report, generation };
  }

  private async themeGap(
    theme: SnapshotTheme,
    snapshot: PursuitSnapshot,
  ): Promise<EvaluatorFinding[]> {
    const { llm } = this.deps;
    const findings: EvaluatorFinding[] = [];

    if (theme.scope.kind === "nodes") {
      for (const nodeId of theme.scope.node_ids) {
        const section = snapshot.sections.find((s) => s.node_id === nodeId);
        const content = section?.content ?? "";
        const verdict = parseThemeGap(
          (
            await llm.complete({
              messages: themeGapMessages(theme.text, content),
              purpose: "theme_gap",
            })
          ).text,
        );
        if (!verdict.covered) {
          findings.push({
            kind: "theme_gap",
            anchor: { kind: "node", node_id: nodeId },
            detail:
              verdict.detail ??
              `Locked theme "${theme.text}" is not reflected in its scoped section.`,
            severity: "warning",
          });
        }
      }
    } else {
      // Pursuit-wide theme: check coverage across the whole draft.
      const content = snapshot.sections.map((s) => s.content).join("\n");
      const verdict = parseThemeGap(
        (
          await llm.complete({
            messages: themeGapMessages(theme.text, content),
            purpose: "theme_gap",
          })
        ).text,
      );
      if (!verdict.covered && snapshot.nodes.length > 0) {
        findings.push({
          kind: "theme_gap",
          anchor: { kind: "node", node_id: snapshot.nodes[0].node_id },
          detail:
            verdict.detail ??
            `Locked theme "${theme.text}" is not reflected anywhere in the draft.`,
          severity: "warning",
        });
      }
    }
    return findings;
  }

  private async coherence(
    snapshot: PursuitSnapshot,
  ): Promise<EvaluatorFinding[]> {
    const { llm } = this.deps;
    const draft = snapshot.nodes
      .map((n) => {
        const section = snapshot.sections.find((s) => s.node_id === n.node_id);
        return `## ${n.title}\n${section?.content ?? ""}`;
      })
      .join("\n\n");

    const out = parseCoherence(
      (
        await llm.complete({
          messages: coherenceMessages(draft),
          purpose: "coherence",
        })
      ).text,
    );

    return out.issues.map((issue) => ({
      kind: "coherence" as const,
      anchor: resolveAnchor(issue.node_id, snapshot),
      detail: issue.detail,
      severity: issue.severity ?? "warning",
    }));
  }
}

// --- code-level repetition -------------------------------------------------

function detectRepetition(snapshot: PursuitSnapshot): EvaluatorFinding[] {
  const passages: {
    node_id: PursuitSnapshot["sections"][number]["node_id"];
    section_id: PursuitSnapshot["sections"][number]["section_id"];
    text: string;
    tokens: Set<string>;
  }[] = [];
  for (const section of snapshot.sections) {
    for (const text of splitPassages(section.content)) {
      passages.push({
        node_id: section.node_id,
        section_id: section.section_id,
        text,
        tokens: tokenize(text),
      });
    }
  }

  const findings: EvaluatorFinding[] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < passages.length; i++) {
    for (let j = i + 1; j < passages.length; j++) {
      const a = passages[i];
      const b = passages[j];
      if (a.section_id === b.section_id) continue; // repetition is cross-section
      if (jaccard(a.tokens, b.tokens) < REPETITION_THRESHOLD) continue;

      const pairKey = [a.section_id, b.section_id].sort().join("|");
      if (seenPairs.has(pairKey)) continue; // one finding per section pair
      seenPairs.add(pairKey);
      findings.push({
        kind: "repetition",
        anchor: { kind: "node", node_id: b.node_id },
        detail: `Near-duplicate passage across sections: "${a.text}" ≈ "${b.text}"`,
        severity: "warning",
      });
    }
  }
  return findings;
}

function splitPassages(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function resolveAnchor(
  nodeId: string | undefined,
  snapshot: PursuitSnapshot,
): ReviewAnchor {
  // Anchor to the named node when it exists in the snapshot; otherwise a
  // coherence finding still must anchor somewhere, so fall back to the first.
  const named = nodeId
    ? snapshot.nodes.find((n) => n.node_id === nodeId)
    : undefined;
  return { kind: "node", node_id: (named ?? snapshot.nodes[0]).node_id };
}

// --- prompt builders -------------------------------------------------------

function themeGapMessages(themeText: string, content: string): LLMMessage[] {
  return [
    {
      role: "system",
      content:
        "You are the Evaluator checking theme coverage. Decide whether the win " +
        'theme is meaningfully reflected in the section. Return JSON: { "covered": true|false, "detail"?: string }.',
    },
    { role: "user", content: `Theme: ${themeText}\n\nSection content:\n${content}` },
  ];
}

function coherenceMessages(draft: string): LLMMessage[] {
  return [
    {
      role: "system",
      content:
        "You are the Evaluator checking coherence across the assembled draft. " +
        'Return JSON: { "issues": [{ "node_id"?: string, "detail": string, "severity"?: "info"|"warning"|"critical" }] }. ' +
        "Return an empty issues array if the draft hangs together.",
    },
    { role: "user", content: draft },
  ];
}

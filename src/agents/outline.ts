import type { GraphStore } from "../graph/store";
import type {
  GenerationRecord,
  OutlineNode,
  OutlineNodeId,
  PursuitContext,
  PursuitId,
  StyleGuide,
} from "../graph/types";
import type { LLM, LLMMessage } from "./fake-llm";

// ---------------------------------------------------------------------------
// Outline agent (agent-definitions.md #3)
//
// Generates the OutlineNode tree from a proposal-type template plus intake
// context. Writes the OutlineNode tree only — never section prose, never page
// budgets at MVP. Regeneration is non-destructive: a node a human has edited is
// preserved verbatim, id included. Unedited agent nodes are refreshed in place
// (stable ids); genuinely new template keys are added; nothing is deleted.
// ---------------------------------------------------------------------------

export interface OutlineTemplateNode {
  readonly key: string;
  readonly title: string;
  readonly annotation: string;
  readonly order: number;
  readonly parent_key: string | null;
}

export interface OutlineTemplate {
  readonly id: string;
  readonly nodes: readonly OutlineTemplateNode[];
}

export interface RawOutlineNode {
  key: string;
  title: string;
  annotation: string;
  order: number;
  parent_key: string | null;
}

export function parseOutlineOutput(text: string): RawOutlineNode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Outline LLM returned non-JSON output");
  }
  const nodes = (parsed as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("Outline LLM output missing a nodes array");
  }
  return nodes.map((n) => {
    const r = n as Record<string, unknown>;
    return {
      key: String(r.key ?? ""),
      title: String(r.title ?? ""),
      annotation: String(r.annotation ?? ""),
      order: Number(r.order ?? 0),
      parent_key: r.parent_key == null ? null : String(r.parent_key),
    };
  });
}

export interface OutlineInput {
  readonly pursuit_id: PursuitId;
  readonly context: PursuitContext;
  readonly template: OutlineTemplate;
  readonly styleGuide?: StyleGuide | null;
  readonly promptTemplateVersion?: string;
  readonly model?: string;
}

export interface OutlineResult {
  readonly nodes: readonly OutlineNode[];
  readonly created: readonly OutlineNodeId[];
  readonly updated: readonly OutlineNodeId[];
  readonly preserved: readonly OutlineNodeId[];
  readonly generation: GenerationRecord;
}

export class OutlineAgent {
  constructor(private readonly deps: { store: GraphStore; llm: LLM }) {}

  async generate(input: OutlineInput): Promise<OutlineResult> {
    const { store, llm } = this.deps;

    const messages = buildOutlineMessages(
      input.template,
      input.context,
      input.styleGuide ?? null,
    );
    const proposed = parseOutlineOutput(
      (await llm.complete({ messages, purpose: "outline" })).text,
    );

    const generation = store.recordGeneration({
      pursuit_id: input.pursuit_id,
      agent: "outline",
      inputs: {
        node_id: null,
        requirement_ids: [],
        theme_versions: [],
        style_guide_version: input.styleGuide?.version ?? null,
        retrieved_passage_ids: [],
        prompt_template_version: input.promptTemplateVersion ?? "outline-v1",
        model: input.model ?? "fake-model",
      },
      output_revision_id: null,
    });

    const keyToId = new Map<string, OutlineNodeId>();
    const created: OutlineNodeId[] = [];
    const updated: OutlineNodeId[] = [];
    const preserved: OutlineNodeId[] = [];

    // Pass 1: reconcile each proposed node against existing state by template key.
    for (const p of proposed) {
      const existing = store.findOutlineNodeByTemplateKey(
        input.pursuit_id,
        p.key,
      );
      if (existing) {
        if (store.outlineNodeOrigin(existing.id) === "human") {
          // Human owns it now — leave it entirely untouched.
          keyToId.set(p.key, existing.id);
          preserved.push(existing.id);
          continue;
        }
        // Agent node: refresh content, keep the id stable.
        store.renameNode(existing.id, p.title);
        store.setNodeAnnotation(existing.id, p.annotation);
        store.reorderNode(existing.id, { order: p.order });
        keyToId.set(p.key, existing.id);
        updated.push(existing.id);
      } else {
        const node = store.addNode({
          pursuit_id: input.pursuit_id,
          order: p.order,
          title: p.title,
          annotation: p.annotation,
          parent_id: null,
        });
        store.tagOutlineNode(node.id, p.key);
        keyToId.set(p.key, node.id);
        created.push(node.id);
      }
    }

    // Pass 2: wire parents — only for agent-owned nodes. Human nodes keep theirs.
    for (const p of proposed) {
      const id = keyToId.get(p.key);
      if (!id) continue;
      if (store.outlineNodeOrigin(id) === "human") continue;
      const parentId = p.parent_key ? keyToId.get(p.parent_key) ?? null : null;
      store.reorderNode(id, { parent_id: parentId });
    }

    const nodes = proposed
      .map((p) => store.getNode(keyToId.get(p.key)!))
      .filter((n): n is OutlineNode => n !== undefined);

    return { nodes, created, updated, preserved, generation };
  }
}

function buildOutlineMessages(
  template: OutlineTemplate,
  context: PursuitContext,
  styleGuide: StyleGuide | null,
): LLMMessage[] {
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
  const templateBlock = template.nodes
    .map((n) => `- [${n.key}] ${n.title}: ${n.annotation}`)
    .join("\n");
  const systemParts = [
    "You are the Outline agent. Produce an annotated outline from the template " +
      "and intake context. Each node needs a title, purpose annotation, and order.",
    "Return JSON: { nodes: [{key, title, annotation, order, parent_key}] }.",
    "Reuse the template keys so the outline is stable across regenerations.",
    "Do not write section prose. Do not assign page budgets.",
  ];
  if (styleGuide) {
    systemParts.push(`Style guide (v${styleGuide.version}):\n${styleGuide.content}`);
  }
  return [
    { role: "system", content: systemParts.join("\n\n") },
    {
      role: "user",
      content: `Template:\n${templateBlock}\n\nIntake context:\n${contextBlock}`,
    },
  ];
}

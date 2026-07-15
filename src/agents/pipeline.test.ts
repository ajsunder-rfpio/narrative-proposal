import { describe, it, expect } from "vitest";

import { GraphStore } from "../graph";
import type { OrgId, PursuitContext, PursuitId, UserId } from "../graph/types";
import {
  IntakeAgent,
  OutlineAgent,
  ThemeAgent,
  Orchestrator,
  FixtureSourceReader,
  ScriptedLLM,
  HallucinatingLLM,
  type OutlineTemplate,
} from "./index";

const ORG = "org_1" as OrgId;
const USER = "user_1" as UserId;

let tick = 0;
function makeStore() {
  tick = 0;
  return new GraphStore({
    clock: () => `2026-03-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
}

function newPursuit(store: GraphStore): PursuitId {
  return store.createPursuit({
    org_id: ORG,
    name: "Test Pursuit",
    kind: "proactive_proposal",
    owner_id: USER,
  }).id;
}

function seedSources(store: GraphStore, pursuit: PursuitId) {
  const transcript = store.addIntakeSource({
    pursuit_id: pursuit,
    kind: "transcript",
    uri: "s3://transcript",
  });
  const crm = store.addIntakeSource({
    pursuit_id: pursuit,
    kind: "crm_extract",
    uri: "s3://crm",
  });
  const reader = new FixtureSourceReader({
    [transcript.id]:
      "The customer is Acme Corp. They struggle with slow proposal turnaround. " +
      "The scope covers three product lines. Budget is around $200k.",
    [crm.id]: "Primary stakeholder is Dana Lee, VP of Growth.",
  });
  return { transcript, crm, reader };
}

const EMPTY_CONTEXT = (pursuit: PursuitId): PursuitContext => ({
  pursuit_id: pursuit,
  fields: [],
  generation_record_id: null,
});

const TEMPLATE: OutlineTemplate = {
  id: "proactive-proposal-v1",
  nodes: [
    { key: "exec", title: "Executive Summary", annotation: "Frame the win.", order: 0, parent_key: null },
    { key: "approach", title: "Approach", annotation: "How we deliver.", order: 1, parent_key: null },
    { key: "pricing", title: "Pricing", annotation: "Commercials.", order: 2, parent_key: null },
  ],
};

const OUTLINE_JSON = JSON.stringify({
  nodes: [
    { key: "exec", title: "Executive Summary", annotation: "Frame the win.", order: 0, parent_key: null },
    { key: "approach", title: "Our Approach", annotation: "How we deliver value.", order: 1, parent_key: null },
    { key: "pricing", title: "Investment", annotation: "Commercials.", order: 2, parent_key: null },
  ],
});

const THEME_JSON = JSON.stringify({
  themes: [
    { kind: "theme", text: "Proven platform, lower risk", scope: "pursuit" },
    { kind: "discriminator", text: "Only vendor with a federal ATO", scope: "pursuit" },
    { kind: "ghost", text: "Incumbents rely on manual effort", scope: "pursuit" },
  ],
});

describe("Intake agent", () => {
  it("extracts grounded facts with source locators and reports unfindable fields as not_found", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const { transcript, crm, reader } = seedSources(store, pursuit);

    const intakeJSON = JSON.stringify({
      facts: [
        { key: "customer", value: "Acme Corp", source_id: transcript.id, quote: "customer is Acme Corp" },
        { key: "problem", value: "slow proposal turnaround", source_id: transcript.id, quote: "slow proposal turnaround" },
        { key: "scope", value: "three product lines", source_id: transcript.id, quote: "three product lines" },
        { key: "budget_signals", value: "~$200k", source_id: transcript.id, quote: "Budget is around $200k" },
        { key: "stakeholders", value: "Dana Lee, VP of Growth", source_id: crm.id, quote: "Dana Lee, VP of Growth" },
        // Fabricated: this quote is in no source, so it must be dropped.
        { key: "customer", value: "BetaCorp", source_id: transcript.id, quote: "the customer is BetaCorp" },
      ],
    });

    const intake = new IntakeAgent({
      store,
      llm: new ScriptedLLM({ byPurpose: { intake: intakeJSON } }),
    });
    const result = await intake.parse({
      pursuit_id: pursuit,
      sources: [transcript, crm],
      reader,
    });

    const byKey = new Map(result.context.fields.map((f) => [f.key, f]));
    // competitive_mentions was never in a source -> explicit not_found, not silence.
    expect(byKey.get("competitive_mentions")?.status).toBe("not_found");
    expect(byKey.get("customer")?.status).toBe("found");
    // The ungrounded BetaCorp fact was dropped, not stored.
    expect(byKey.get("customer")?.facts).toHaveLength(1);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].value).toBe("BetaCorp");

    // Every stored fact carries a locator back to its source.
    const allFacts = result.context.fields.flatMap((f) => f.facts);
    expect(allFacts.length).toBeGreaterThan(0);
    for (const fact of allFacts) {
      expect(fact.source.source_id).toBeTruthy();
      expect(fact.source.locator).toBeTruthy();
    }

    // The context was persisted.
    expect(store.getPursuitContext(pursuit)?.fields).toHaveLength(6);
  });

  it("invents nothing — HallucinatingLLM's fabricated context is dropped, never stored", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const source = store.addIntakeSource({
      pursuit_id: pursuit,
      kind: "transcript",
      uri: "s3://t",
    });
    const reader = new FixtureSourceReader({
      [source.id]: "The customer is Acme Corp.",
    });

    const intake = new IntakeAgent({ store, llm: new HallucinatingLLM() });
    const result = await intake.parse({
      pursuit_id: pursuit,
      sources: [source],
      reader,
    });

    // The fabrication was dropped; nothing was stored as fact.
    expect(result.dropped).toHaveLength(1);
    expect(result.context.fields.every((f) => f.status === "not_found")).toBe(true);
    expect(result.context.fields.flatMap((f) => f.facts)).toHaveLength(0);
  });
});

describe("Outline agent", () => {
  it("regeneration preserves a human-edited node verbatim, including its id", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const outline = new OutlineAgent({
      store,
      llm: new ScriptedLLM({ byPurpose: { outline: OUTLINE_JSON } }),
    });

    // First generation.
    await outline.generate({
      pursuit_id: pursuit,
      context: EMPTY_CONTEXT(pursuit),
      template: TEMPLATE,
    });
    const approachV1 = store.findOutlineNodeByTemplateKey(pursuit, "approach")!;
    const execIdV1 = store.findOutlineNodeByTemplateKey(pursuit, "exec")!.id;
    const originalAnnotation = approachV1.annotation;

    // A human takes over the "approach" node and renames it.
    store.editNodeAsHuman(approachV1.id, { title: "Our Tailored Approach (human)" });

    // Regenerate.
    const gen2 = await outline.generate({
      pursuit_id: pursuit,
      context: EMPTY_CONTEXT(pursuit),
      template: TEMPLATE,
    });

    const approachV2 = store.getNode(approachV1.id)!;
    // Same id, human title untouched, annotation verbatim.
    expect(approachV2.id).toBe(approachV1.id);
    expect(approachV2.title).toBe("Our Tailored Approach (human)");
    expect(approachV2.annotation).toBe(originalAnnotation);
    expect(gen2.preserved).toContain(approachV1.id);

    // Unedited agent nodes keep stable ids across regeneration (no churn).
    expect(store.findOutlineNodeByTemplateKey(pursuit, "exec")!.id).toBe(execIdV1);
    expect(gen2.updated).toContain(execIdV1);
    expect(gen2.updated).not.toContain(approachV1.id);
  });
});

describe("Theme agent", () => {
  it("regeneration adds drafts alongside and never overwrites a human-edited theme; output is always draft", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const theme = new ThemeAgent({
      store,
      llm: new ScriptedLLM({ byPurpose: { theme: THEME_JSON } }),
    });

    const first = await theme.draft({ pursuit_id: pursuit, context: EMPTY_CONTEXT(pursuit) });
    expect(first.themes).toHaveLength(3);
    expect(first.themes.every((t) => t.status === "draft")).toBe(true);

    // A human edits one theme.
    const edited = store.editThemeAsHuman(
      first.themes[0].id,
      { text: "Human-refined theme" },
      USER,
    );
    expect(edited.text).toBe("Human-refined theme");

    // Regenerate: adds new drafts alongside, touches nothing existing.
    const second = await theme.draft({ pursuit_id: pursuit, context: EMPTY_CONTEXT(pursuit) });
    expect(second.themes).toHaveLength(3);

    // The human-edited theme is unchanged.
    expect(store.getTheme(first.themes[0].id)?.text).toBe("Human-refined theme");
    // Six themes now exist, and none were locked by the agent.
    const all = store.listThemes(pursuit);
    expect(all).toHaveLength(6);
    expect(all.every((t) => t.status === "draft")).toBe(true);
  });
});

describe("Orchestrator", () => {
  it("runs intake -> themes and stops at the human-lock gate; advances only once a theme is locked", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const { transcript, crm, reader } = seedSources(store, pursuit);

    // One LLM, routed by purpose, serves all three agents.
    const intakeJSON = JSON.stringify({
      facts: [
        { key: "customer", value: "Acme Corp", source_id: transcript.id, quote: "customer is Acme Corp" },
      ],
    });
    const llm = new ScriptedLLM({
      byPurpose: { intake: intakeJSON, outline: OUTLINE_JSON, theme: THEME_JSON },
    });

    const orchestrator = new Orchestrator({
      store,
      intake: new IntakeAgent({ store, llm }),
      outline: new OutlineAgent({ store, llm }),
      theme: new ThemeAgent({ store, llm }),
    });

    const result = await orchestrator.run({
      pursuit_id: pursuit,
      sources: [transcript, crm],
      reader,
      template: TEMPLATE,
    });

    // Stopped at the gate: no theme is locked yet.
    expect(result.blockedGate).toMatch(/themes must be human-locked/);
    expect(result.stage).toBe("outline");
    expect(result.stagesVisited).toEqual(["intake", "outline"]);
    expect(store.getPursuit(pursuit)?.stage).toBe("outline");

    // The pipeline produced outline nodes and draft themes along the way.
    expect(result.nodes).toHaveLength(3);
    expect(result.themes).toHaveLength(3);
    expect(result.themes.every((t) => t.status === "draft")).toBe(true);

    // A human locks a theme; only now may the Orchestrator advance to drafting.
    store.lockTheme(result.themes[0].id, USER);
    const advance = orchestrator.tryAdvanceToDrafting(pursuit);
    expect(advance.advanced).toBe(true);
    expect(advance.gate).toBeNull();
    expect(store.getPursuit(pursuit)?.stage).toBe("drafting");
  });
});

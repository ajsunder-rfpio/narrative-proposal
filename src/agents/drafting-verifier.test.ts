import { describe, it, expect } from "vitest";

import { GraphStore, GraphError } from "../graph";
import type {
  Asset,
  OrgId,
  Passage,
  PursuitId,
  StyleGuideId,
  UserId,
} from "../graph/types";
import {
  DraftingAgent,
  VerifierAgent,
  InMemoryLibrary,
  ScriptedLLM,
  HallucinatingLLM,
  GAP_MARKER,
  type LibraryEntry,
} from "./index";

const ORG = "org_1" as OrgId;
const USER = "user_1" as UserId;

let tick = 0;
function makeStore() {
  tick = 0;
  return new GraphStore({
    clock: () => `2026-02-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
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

/** Seed an asset with passages into the store AND return a library entry, so the
 *  retriever and the Verifier (via store.getPassage) see the same passages. */
function seedAsset(
  store: GraphStore,
  passageTexts: readonly string[],
): { asset: Asset; passages: Passage[]; entry: LibraryEntry } {
  const asset = store.addAsset({
    org_id: ORG,
    kind: "past_performance",
    title: "Acme Past Performance",
    source_uri: "lib://acme",
    metadata: {
      customer: "Acme",
      vertical: "gov",
      contract_vehicle: null,
      outcome: "win",
      date: "2021-01-01",
    },
    sensitivity: "internal",
    governance: { approved_by: USER, review_date: null, expiry: null },
  });
  const passages = passageTexts.map((text, i) =>
    store.addPassage({
      asset_id: asset.id,
      parent_id: null,
      text,
      locator: `p.${i + 1}`,
    }),
  );
  return { asset, passages, entry: { asset, passages } };
}

describe("Drafting agent", () => {
  it("HallucinatingLLM: fabricated claim is flagged unsupported, and its text stays in the revision", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const node = store.addNode({
      pursuit_id: pursuit,
      order: 0,
      title: "Past Performance",
      annotation: "Describe Acme field trials and case study outcomes.",
    });

    // A real passage that contains the fabrication's quote verbatim, but does
    // NOT support the inflated claim.
    const { entry } = seedAsset(store, [
      `In a 2021 case study, ${HallucinatingLLM.QUOTE} at a single Acme facility.`,
    ]);
    const library = new InMemoryLibrary([entry]);

    const drafting = new DraftingAgent({
      store,
      llm: new HallucinatingLLM(),
      retriever: library,
    });
    const result = await drafting.draft({
      node,
      promptTemplateVersion: "draft-v1",
      model: "fake-model",
    });

    // Drafting grounded the fabricated claim on the real snippet.
    expect(result.claims).toHaveLength(1);
    expect(result.revision.content).toContain(HallucinatingLLM.FABRICATION);

    // A correct Verifier would reject it on entailment.
    const verifier = new VerifierAgent({
      store,
      llm: new ScriptedLLM({
        byPurpose: { verify: JSON.stringify({ entailed: false }) },
      }),
    });
    const verdict = await verifier.verify(result.claims[0].id);

    expect(verdict.layer).toBe("entailment");
    expect(verdict.status).toBe("unsupported");
    expect(store.getClaim(result.claims[0].id)?.verification_status).toBe(
      "unsupported",
    );
    // Nothing silently removed: the flagged claim text is still in the prose.
    expect(store.getRevision(result.revision.id)?.content).toContain(
      HallucinatingLLM.FABRICATION,
    );
  });

  it("empty retrieval yields the gap marker, not smooth prose, and creates no claim", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const node = store.addNode({
      pursuit_id: pursuit,
      order: 0,
      title: "Value",
      annotation: "State the cost savings.",
    });

    const drafting = new DraftingAgent({
      store,
      llm: new ScriptedLLM({
        byPurpose: {
          draft: JSON.stringify({
            segments: [
              { kind: "text", text: "We deliver measurable value. " },
              {
                kind: "claim",
                text: "We cut costs 40%.",
                quote: "cut costs 40%",
                proof_point: "cost savings",
              },
            ],
          }),
        },
      }),
      retriever: new InMemoryLibrary([]), // nothing to retrieve
    });

    const result = await drafting.draft({
      node,
      promptTemplateVersion: "draft-v1",
      model: "fake-model",
    });

    expect(result.retrieved).toHaveLength(0);
    expect(result.claims).toHaveLength(0);
    expect(result.revision.content).toContain(GAP_MARKER);
    expect(result.revision.content).not.toContain("We cut costs 40%.");
    expect(result.gaps).toContain("cost savings");
  });

  it("the drafting agent cannot write verification_status — the graph store refuses it", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const node = store.addNode({
      pursuit_id: pursuit,
      order: 0,
      title: "Approach",
      annotation: "Describe the approach.",
    });
    const { entry } = seedAsset(store, [
      "Our platform reduced costs across the deployment.",
    ]);

    const drafting = new DraftingAgent({
      store,
      llm: new ScriptedLLM({
        byPurpose: {
          draft: JSON.stringify({
            segments: [
              {
                kind: "claim",
                text: "Our platform reduced costs.",
                quote: "reduced costs",
                proof_point: "cost",
              },
            ],
          }),
        },
      }),
      retriever: new InMemoryLibrary([entry]),
    });
    const result = await drafting.draft({
      node,
      promptTemplateVersion: "draft-v1",
      model: "fake-model",
    });
    const claimId = result.claims[0].id;

    // Drafting's only claim-mutation door is updateClaim, which refuses the field.
    expect(() =>
      // @ts-expect-error verification_status is excluded from the patch type
      store.updateClaim(claimId, { verification_status: "verified" }),
    ).toThrow(GraphError);
    expect(store.getClaim(claimId)?.verification_status).toBe("pending");
  });

  it("GenerationRecord captures node, theme versions, and retrieved passage ids", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const node = store.addNode({
      pursuit_id: pursuit,
      order: 0,
      title: "Approach",
      annotation: "Describe the approach and the platform deployment.",
    });

    const theme = store.createTheme({
      pursuit_id: pursuit,
      kind: "theme",
      text: "Proven platform, lower risk",
    });
    const lockedTheme = store.lockTheme(theme.id, USER);

    const { entry, passages } = seedAsset(store, [
      "The platform deployment lowered risk for the approach.",
      "An unrelated boilerplate paragraph about logistics.",
    ]);
    const library = new InMemoryLibrary([entry]);

    const styleGuide = {
      id: "StyleGuide_1" as StyleGuideId,
      org_id: ORG,
      version: 3,
      content: "Be concise.",
    };

    const drafting = new DraftingAgent({
      store,
      llm: new ScriptedLLM({
        byPurpose: {
          draft: JSON.stringify({
            segments: [
              { kind: "text", text: "Our approach is proven. " },
              {
                kind: "claim",
                text: "The deployment lowered risk.",
                quote: "lowered risk",
                proof_point: "risk",
              },
            ],
          }),
        },
      }),
      retriever: library,
    });

    const result = await drafting.draft({
      node,
      lockedThemes: [lockedTheme],
      styleGuide,
      promptTemplateVersion: "draft-v7",
      model: "fake-model",
    });

    const gen = store.getGenerationRecord(result.generation.id)!;
    expect(gen.agent).toBe("drafting");
    expect(gen.inputs.node_id).toBe(node.id);
    expect(gen.inputs.theme_versions).toEqual([
      { theme_id: theme.id, version: 1 },
    ]);
    expect(gen.inputs.style_guide_version).toBe(3);
    expect(gen.inputs.prompt_template_version).toBe("draft-v7");
    // Captures exactly what retrieval surfaced, and links back to the revision.
    expect(gen.inputs.retrieved_passage_ids).toEqual(
      result.retrieved.map((r) => r.passage.id),
    );
    expect(gen.inputs.retrieved_passage_ids).toContain(passages[0].id);
    expect(gen.output_revision_id).toBe(result.revision.id);
  });
});

describe("Verifier agent", () => {
  it("fails a claim in code when the citation quote is not verbatim in the passage — no LLM call", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "S" });
    const section = store.createSection(node.id);
    const rev = store.commitRevision({
      section_id: section.id,
      content: "Our system is fast.",
      author: { by: "agent", agent: "drafting" },
    });

    const { passages } = seedAsset(store, [
      "This passage is about something entirely unrelated.",
    ]);
    const claim = store.addClaim({
      section_id: section.id,
      anchor: { revision_id: rev.id, start: 0, end: 19 },
      text: "Our system is fast.",
    });
    // A citation whose quote does NOT appear in the cited passage.
    store.addCitation({
      claim_id: claim.id,
      asset_id: passages[0].asset_id,
      passage_id: passages[0].id,
      quote: "our system is fast",
      locator: "p.1",
    });

    // If the verifier reached the LLM, this fake would throw on an unscripted call.
    const spyLLM = new ScriptedLLM();
    const verifier = new VerifierAgent({ store, llm: spyLLM });
    const verdict = await verifier.verify(claim.id);

    expect(verdict.status).toBe("unsupported");
    expect(verdict.layer).toBe("code");
    expect(verdict.llmCalled).toBe(false);
    expect(spyLLM.calls).toHaveLength(0);
    expect(store.getClaim(claim.id)?.verification_status).toBe("unsupported");
  });

  it("verifies a well-grounded, entailed claim through the entailment layer", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "S" });
    const section = store.createSection(node.id);
    const rev = store.commitRevision({
      section_id: section.id,
      content: "Our platform reduced costs.",
      author: { by: "agent", agent: "drafting" },
    });
    const { passages } = seedAsset(store, [
      "The platform reduced costs by a third in the pilot.",
    ]);
    const claim = store.addClaim({
      section_id: section.id,
      anchor: { revision_id: rev.id, start: 0, end: 26 },
      text: "Our platform reduced costs.",
    });
    store.addCitation({
      claim_id: claim.id,
      asset_id: passages[0].asset_id,
      passage_id: passages[0].id,
      quote: "reduced costs",
      locator: "p.1",
    });

    const verifier = new VerifierAgent({
      store,
      llm: new ScriptedLLM({
        byPurpose: { verify: JSON.stringify({ entailed: true }) },
      }),
    });
    const verdict = await verifier.verify(claim.id);

    expect(verdict.layer).toBe("entailment");
    expect(verdict.llmCalled).toBe(true);
    expect(verdict.status).toBe("verified");
    expect(store.getClaim(claim.id)?.verification_status).toBe("verified");
  });
});

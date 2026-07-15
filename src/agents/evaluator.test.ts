import { describe, it, expect } from "vitest";

import { GraphStore, GraphError } from "../graph";
import type {
  OrgId,
  PursuitId,
  SectionId,
  SectionRevisionId,
  UserId,
} from "../graph/types";
import { EvaluatorAgent, ScriptedLLM } from "./index";

const ORG = "org_1" as OrgId;
const USER = "user_1" as UserId;

let tick = 0;
function makeStore() {
  tick = 0;
  return new GraphStore({
    clock: () => `2026-04-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
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

let order = 0;
function seedSection(
  store: GraphStore,
  pursuit: PursuitId,
  opts: { title: string; annotation?: string; content: string },
) {
  const node = store.addNode({
    pursuit_id: pursuit,
    order: order++,
    title: opts.title,
    annotation: opts.annotation ?? "",
  });
  store.setNodeStatus(node.id, "drafting");
  const section = store.createSection(node.id);
  const rev = store.commitRevision({
    section_id: section.id,
    content: opts.content,
    author: { by: "agent", agent: "drafting" },
  });
  return { node, section, rev };
}

function addClaim(
  store: GraphStore,
  section: { id: SectionId },
  rev: { id: SectionRevisionId },
  text: string,
) {
  return store.addClaim({
    section_id: section.id,
    anchor: { revision_id: rev.id, start: 0, end: text.length },
    text,
  });
}

const NO_ISSUES = '{"issues":[]}';

describe("Evaluator agent", () => {
  it("flags an unsupported claim from the frozen verdict, anchored to the claim, with no verification call", async () => {
    order = 0;
    const store = makeStore();
    const pursuit = newPursuit(store);
    const { section, rev } = seedSection(store, pursuit, {
      title: "Approach",
      content: "Our platform is proven.",
    });
    const claim = addClaim(store, section, rev, "Our platform is proven.");
    // The Verifier already ruled it unsupported before the snapshot.
    store.verifier().setVerificationStatus(claim.id, "unsupported");

    const snapshot = store.createSnapshot({ pursuit_id: pursuit, label: "pink" });

    const llm = new ScriptedLLM({ byPurpose: { coherence: NO_ISSUES } });
    const { report } = await new EvaluatorAgent({ store, llm }).evaluate({ snapshot });

    const unsupported = report.findings.filter((f) => f.kind === "unsupported_claim");
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].anchor).toEqual({ kind: "claim", claim_id: claim.id });
    expect(unsupported[0].severity).toBe("critical");
    // It consumed the verdict — it never re-verified.
    expect(llm.calls.every((c) => c.purpose !== "verify")).toBe(true);
  });

  it("detects near-identical passages across sections as a repetition finding, in code", async () => {
    order = 0;
    const store = makeStore();
    const pursuit = newPursuit(store);
    const dup = "Our platform reduced operating costs by thirty percent for Acme.";
    const a = seedSection(store, pursuit, { title: "Executive Summary", content: dup });
    seedSection(store, pursuit, { title: "Past Performance", content: dup });

    const snapshot = store.createSnapshot({ pursuit_id: pursuit, label: "pink" });

    const llm = new ScriptedLLM({ byPurpose: { coherence: NO_ISSUES } });
    const { report } = await new EvaluatorAgent({ store, llm }).evaluate({ snapshot });

    const repetition = report.findings.filter((f) => f.kind === "repetition");
    expect(repetition).toHaveLength(1);
    expect(repetition[0].anchor.kind).toBe("node");
    // Code-level: the only LLM call made was the coherence pass, never repetition.
    expect(llm.calls.every((c) => c.purpose === "coherence")).toBe(true);
    // Anchored to a real node in the snapshot.
    expect(snapshot.nodes.some((n) => n.title === "Past Performance")).toBe(true);
    void a;
  });

  it("flags a locked theme absent from its scoped section as a theme_gap, anchored to that node", async () => {
    order = 0;
    const store = makeStore();
    const pursuit = newPursuit(store);
    const { node } = seedSection(store, pursuit, {
      title: "Approach",
      content: "We describe our staffing plan and timeline.",
    });
    const theme = store.createTheme({
      pursuit_id: pursuit,
      kind: "discriminator",
      text: "Only vendor with a federal ATO",
      scope: { kind: "nodes", node_ids: [node.id] },
    });
    store.lockTheme(theme.id, USER);

    const snapshot = store.createSnapshot({ pursuit_id: pursuit, label: "pink" });

    const llm = new ScriptedLLM({
      byPurpose: {
        theme_gap: JSON.stringify({ covered: false, detail: "ATO never mentioned" }),
        coherence: NO_ISSUES,
      },
    });
    const { report } = await new EvaluatorAgent({ store, llm }).evaluate({ snapshot });

    const gaps = report.findings.filter((f) => f.kind === "theme_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].anchor).toEqual({ kind: "node", node_id: node.id });
    expect(gaps[0].detail).toContain("ATO never mentioned");
  });

  it("keeps the report format identical without evaluation criteria — scores is simply empty", async () => {
    order = 0;
    const store = makeStore();
    const pursuit = newPursuit(store);
    const { section, rev } = seedSection(store, pursuit, {
      title: "Approach",
      content: "Our platform is proven.",
    });
    const claim = addClaim(store, section, rev, "Our platform is proven.");
    store.verifier().setVerificationStatus(claim.id, "unsupported");

    const snapshot = store.createSnapshot({ pursuit_id: pursuit, label: "pink" });
    const llm = new ScriptedLLM({ byPurpose: { coherence: NO_ISSUES } });
    const { report } = await new EvaluatorAgent({ store, llm }).evaluate({ snapshot });

    // Same shape every time; the fast-follow only fills scores in, never changes keys.
    expect(Object.keys(report).sort()).toEqual([
      "findings",
      "id",
      "pursuit_id",
      "scores",
      "snapshot_id",
    ]);
    expect(report.scores).toEqual([]);
    expect(report.findings.length).toBeGreaterThan(0);
    // Only the four MVP finding kinds ever appear.
    const MVP = new Set(["unsupported_claim", "repetition", "theme_gap", "coherence"]);
    expect(report.findings.every((f) => MVP.has(f.kind))).toBe(true);
  });

  it("cannot write verification_status or section content — the graph store refuses", async () => {
    order = 0;
    const store = makeStore();
    const pursuit = newPursuit(store);
    const { section, rev } = seedSection(store, pursuit, {
      title: "Approach",
      content: "Our platform is proven.",
    });
    const claim = addClaim(store, section, rev, "Our platform is proven.");

    // The Evaluator holds only { store, llm }. The two writes it must never make
    // are refused by the store: verification_status is Verifier-only ...
    expect(() =>
      // @ts-expect-error verification_status is excluded from the patch type
      store.updateClaim(claim.id, { verification_status: "verified" }),
    ).toThrow(GraphError);
    // ... and section content is immutable — revisions cannot be edited in place.
    expect(() => {
      // @ts-expect-error readonly + frozen at runtime
      rev.content = "rewritten by evaluator";
    }).toThrow(TypeError);
    expect(store.getRevision(rev.id)?.content).toBe("Our platform is proven.");
  });

  it("snapshots are frozen and evaluating never mutates live pursuit state", async () => {
    order = 0;
    const store = makeStore();
    const pursuit = newPursuit(store);
    const { section, rev } = seedSection(store, pursuit, {
      title: "Approach",
      content: "Our platform is proven.",
    });
    const claim = addClaim(store, section, rev, "Our platform is proven.");
    store.verifier().setVerificationStatus(claim.id, "unsupported");

    const snapshot = store.createSnapshot({ pursuit_id: pursuit, label: "pink" });

    // The snapshot is frozen, top and nested.
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot.claims as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error frozen at runtime
      snapshot.claims[0].verification_status = "verified";
    }).toThrow(TypeError);

    const llm = new ScriptedLLM({ byPurpose: { coherence: NO_ISSUES } });
    await new EvaluatorAgent({ store, llm }).evaluate({ snapshot });

    // Live state is untouched by evaluation.
    expect(store.getClaim(claim.id)?.verification_status).toBe("unsupported");
    expect(store.getRevision(rev.id)?.content).toBe("Our platform is proven.");

    // And the capture is truly immutable: a later live change does not reach it.
    store.verifier().setVerificationStatus(claim.id, "verified");
    expect(snapshot.claims[0].verification_status).toBe("unsupported");
    expect(store.getClaim(claim.id)?.verification_status).toBe("verified");
  });
});

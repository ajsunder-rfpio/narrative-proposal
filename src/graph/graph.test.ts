import { describe, it, expect, beforeEach } from "vitest";

import { GraphStore, GraphError } from "./index";
import type { OrgId, UserId, PursuitId } from "./types";

const ORG = "org_1" as OrgId;
const USER = "user_1" as UserId;

// Deterministic clock so created_at / verified_at are reproducible.
let clockTick = 0;
function makeStore() {
  clockTick = 0;
  return new GraphStore({
    clock: () => `2026-01-01T00:00:${String(clockTick++).padStart(2, "0")}.000Z`,
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

describe("write-scope enforcement: pursuit.stage", () => {
  let store: GraphStore;
  let pursuit: PursuitId;

  beforeEach(() => {
    store = makeStore();
    pursuit = newPursuit(store);
  });

  it("a fresh pursuit starts in intake", () => {
    expect(store.getPursuit(pursuit)?.stage).toBe("intake");
  });

  it("the orchestrator interface can advance the stage", () => {
    const updated = store.orchestrator().setStage(pursuit, "outline");
    expect(updated.stage).toBe("outline");
    expect(store.getPursuit(pursuit)?.stage).toBe("outline");
  });

  it("updatePursuit refuses to write stage", () => {
    expect(() =>
      // @ts-expect-error stage is intentionally excluded from the patch type
      store.updatePursuit(pursuit, { stage: "drafting" }),
    ).toThrow(GraphError);
    expect(store.getPursuit(pursuit)?.stage).toBe("intake");
  });

  it("a returned pursuit is frozen — direct field assignment throws", () => {
    const p = store.getPursuit(pursuit)!;
    expect(() => {
      // @ts-expect-error readonly + frozen at runtime
      p.stage = "submitted";
    }).toThrow(TypeError);
  });

  it("updatePursuit still allows non-guarded fields", () => {
    const updated = store.updatePursuit(pursuit, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.stage).toBe("intake");
  });
});

describe("human gates on stage transitions", () => {
  let store: GraphStore;
  let pursuit: PursuitId;

  beforeEach(() => {
    store = makeStore();
    pursuit = newPursuit(store);
  });

  it("blocks drafting until a theme is human-locked, naming the gate", () => {
    store.createTheme({ pursuit_id: pursuit, kind: "theme", text: "Speed wins" });
    expect(() => store.orchestrator().setStage(pursuit, "drafting")).toThrow(
      /themes must be human-locked/,
    );
  });

  it("allows drafting once a human locks a theme", () => {
    const theme = store.createTheme({
      pursuit_id: pursuit,
      kind: "theme",
      text: "Speed wins",
    });
    store.lockTheme(theme.id, USER);
    const updated = store.orchestrator().setStage(pursuit, "drafting");
    expect(updated.stage).toBe("drafting");
  });

  it("blocks submission without an explicit human export click", () => {
    expect(() => store.orchestrator().setStage(pursuit, "submitted")).toThrow(
      /export requires a human click/,
    );
  });

  it("allows submission when the human export click is confirmed", () => {
    const updated = store
      .orchestrator()
      .setStage(pursuit, "submitted", { humanExportConfirmed: true });
    expect(updated.stage).toBe("submitted");
    expect(updated.submitted_at).not.toBeNull();
  });

  it("agents have no lock path — themes are only ever created as drafts", () => {
    const theme = store.createTheme({
      pursuit_id: pursuit,
      kind: "theme",
      text: "Speed wins",
    });
    expect(theme.status).toBe("draft");
  });
});

describe("write-scope enforcement: claim.verification_status", () => {
  let store: GraphStore;
  let sectionId: ReturnType<GraphStore["createSection"]>["id"];
  let claimId: ReturnType<GraphStore["addClaim"]>["id"];

  beforeEach(() => {
    store = makeStore();
    const pursuit = newPursuit(store);
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "S1" });
    const section = store.createSection(node.id);
    sectionId = section.id;
    const rev = store.commitRevision({
      section_id: section.id,
      content: "Our system is fast.",
      author: { by: "agent", agent: "drafting" },
    });
    claimId = store.addClaim({
      section_id: section.id,
      anchor: { revision_id: rev.id, start: 0, end: 19 },
      text: "Our system is fast.",
    }).id;
  });

  it("a drafted claim begins pending", () => {
    expect(store.getClaim(claimId)?.verification_status).toBe("pending");
  });

  it("updateClaim refuses to write verification_status", () => {
    expect(() =>
      // @ts-expect-error verification_status is excluded from the patch type
      store.updateClaim(claimId, { verification_status: "verified" }),
    ).toThrow(GraphError);
    expect(store.getClaim(claimId)?.verification_status).toBe("pending");
  });

  it("the verifier interface writes the verdict", () => {
    const verified = store
      .verifier()
      .setVerificationStatus(claimId, "verified", { method: "entailment" });
    expect(verified.verification_status).toBe("verified");
    expect(verified.verified_at).not.toBeNull();
    expect(verified.method).toBe("entailment");
  });

  it("a returned claim is frozen — direct field assignment throws", () => {
    const claim = store.getClaim(claimId)!;
    expect(() => {
      // @ts-expect-error readonly + frozen at runtime
      claim.verification_status = "verified";
    }).toThrow(TypeError);
  });

  it("an edit intersecting a claim span marks it stale; the verifier is the only path back", () => {
    store.verifier().setVerificationStatus(claimId, "verified");
    // Human edits the span the claim sits on.
    store.commitRevision({
      section_id: sectionId,
      content: "Our system is blazing fast.",
      author: { by: "user", user_id: USER },
      editedRanges: [{ start: 0, end: 27 }],
    });
    expect(store.getClaim(claimId)?.verification_status).toBe("stale");
  });

  it("an edit elsewhere in the section leaves a verified claim verified", () => {
    store.verifier().setVerificationStatus(claimId, "verified");
    store.commitRevision({
      section_id: sectionId,
      content: "Our system is fast. Also reliable.",
      author: { by: "user", user_id: USER },
      editedRanges: [{ start: 19, end: 34 }], // appended text, past the claim span
    });
    expect(store.getClaim(claimId)?.verification_status).toBe("verified");
  });
});

describe("section content: immutable revisions only", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("commitRevision appends and advances the head without touching prior revisions", () => {
    const pursuit = newPursuit(store);
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "S1" });
    const section = store.createSection(node.id);

    const r1 = store.commitRevision({
      section_id: section.id,
      content: "First.",
      author: { by: "agent", agent: "drafting" },
    });
    const r2 = store.commitRevision({
      section_id: section.id,
      content: "Second.",
      author: { by: "user", user_id: USER },
    });

    expect(r2.parent_revision_id).toBe(r1.id);
    expect(store.getSection(section.id)?.current_revision_id).toBe(r2.id);
    // The original revision is unchanged — history is real, not overwritten.
    expect(store.getRevision(r1.id)?.content).toBe("First.");
    expect(store.revisionHistory(section.id).map((r) => r.id)).toEqual([
      r1.id,
      r2.id,
    ]);
  });

  it("a returned revision is frozen — content cannot be edited in place", () => {
    const pursuit = newPursuit(store);
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "S1" });
    const section = store.createSection(node.id);
    const rev = store.commitRevision({
      section_id: section.id,
      content: "Immutable.",
      author: { by: "agent", agent: "drafting" },
    });
    expect(() => {
      // @ts-expect-error readonly + frozen at runtime
      rev.content = "mutated";
    }).toThrow(TypeError);
    expect(store.getRevision(rev.id)?.content).toBe("Immutable.");
  });
});

describe("OutlineNode identity: permanent across rename and reorder", () => {
  let store: GraphStore;
  let pursuit: PursuitId;

  beforeEach(() => {
    store = makeStore();
    pursuit = newPursuit(store);
  });

  it("rename preserves the node id", () => {
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "Old" });
    const renamed = store.renameNode(node.id, "New");
    expect(renamed.id).toBe(node.id);
    expect(renamed.title).toBe("New");
  });

  it("reorder and reparent preserve the node id", () => {
    const parent = store.addNode({ pursuit_id: pursuit, order: 0, title: "Parent" });
    const child = store.addNode({
      pursuit_id: pursuit,
      parent_id: null,
      order: 1,
      title: "Child",
    });
    const moved = store.reorderNode(child.id, { order: 0, parent_id: parent.id });
    expect(moved.id).toBe(child.id);
    expect(moved.order).toBe(0);
    expect(moved.parent_id).toBe(parent.id);
  });

  it("ids are never reused after deletion", () => {
    const a = store.addNode({ pursuit_id: pursuit, order: 0, title: "A" });
    const b = store.addNode({ pursuit_id: pursuit, order: 1, title: "B" });
    store.deleteNode(a.id);
    const c = store.addNode({ pursuit_id: pursuit, order: 2, title: "C" });
    expect(c.id).not.toBe(a.id);
    expect(c.id).not.toBe(b.id);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("mappings keep pointing at the same node id through a reorder", () => {
    const req = store.addRequirement({
      pursuit_id: pursuit,
      source_ref: { source_id: "IntakeSource_x" as never, locator: "L.1" },
      kind: "instruction",
      text: "Shall do the thing",
      priority: "shall",
    });
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "N" });
    store.addMapping({
      requirement_id: req.id,
      outline_node_id: node.id,
      created_by: "agent",
    });
    store.reorderNode(node.id, { order: 5 });
    expect(store.mappingsForRequirement(req.id)[0].outline_node_id).toBe(node.id);
  });
});

describe("coverage is computed, never stored", () => {
  let store: GraphStore;
  let pursuit: PursuitId;

  beforeEach(() => {
    store = makeStore();
    pursuit = newPursuit(store);
  });

  function addReq() {
    return store.addRequirement({
      pursuit_id: pursuit,
      source_ref: { source_id: "IntakeSource_x" as never, locator: "L.1" },
      kind: "instruction",
      text: "Shall describe the approach",
      priority: "shall",
    });
  }

  it("unmapped when nothing maps to it", () => {
    const req = addReq();
    expect(store.coverageStatus(req.id)).toBe("unmapped");
  });

  it("mapped when a node is mapped but has no drafted content", () => {
    const req = addReq();
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "N" });
    store.setNodeStatus(node.id, "drafting");
    store.addMapping({
      requirement_id: req.id,
      outline_node_id: node.id,
      created_by: "agent",
    });
    expect(store.coverageStatus(req.id)).toBe("mapped");
  });

  it("addressed when the mapped node has content but claims are unverified", () => {
    const req = addReq();
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "N" });
    store.setNodeStatus(node.id, "drafting");
    const section = store.createSection(node.id);
    const rev = store.commitRevision({
      section_id: section.id,
      content: "We do the thing well.",
      author: { by: "agent", agent: "drafting" },
    });
    store.addClaim({
      section_id: section.id,
      anchor: { revision_id: rev.id, start: 0, end: 21 },
      text: "We do the thing well.",
    });
    store.addMapping({
      requirement_id: req.id,
      outline_node_id: node.id,
      created_by: "agent",
    });
    expect(store.coverageStatus(req.id)).toBe("addressed");
  });

  it("verified only once every supporting claim is verified", () => {
    const req = addReq();
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "N" });
    store.setNodeStatus(node.id, "drafting");
    const section = store.createSection(node.id);
    const rev = store.commitRevision({
      section_id: section.id,
      content: "We do the thing well.",
      author: { by: "agent", agent: "drafting" },
    });
    const claim = store.addClaim({
      section_id: section.id,
      anchor: { revision_id: rev.id, start: 0, end: 21 },
      text: "We do the thing well.",
    });
    store.addMapping({
      requirement_id: req.id,
      outline_node_id: node.id,
      created_by: "agent",
    });
    expect(store.coverageStatus(req.id)).toBe("addressed");
    store.verifier().setVerificationStatus(claim.id, "verified");
    expect(store.coverageStatus(req.id)).toBe("verified");
  });

  it("Requirement records carry no coverage_status field to write", () => {
    const req = addReq();
    expect("coverage_status" in req).toBe(false);
  });
});

describe("persistence seam: export / import round-trip", () => {
  it("rehydrates a pursuit's full graph state, preserving guarded fields, provenance, and id permanence", () => {
    const store = makeStore();
    const pursuit = newPursuit(store);

    // Build a rich state exercising the guarded fields and provenance.
    store.addIntakeSource({ pursuit_id: pursuit, kind: "transcript", uri: "s3://t" });
    const node = store.addNode({ pursuit_id: pursuit, order: 0, title: "Approach" });
    store.tagOutlineNode(node.id, "approach");
    store.editNodeAsHuman(node.id, { title: "Human Approach" }); // origin -> human
    const deleted = store.addNode({ pursuit_id: pursuit, order: 1, title: "Temp" });
    store.deleteNode(deleted.id); // retires an id
    const section = store.createSection(node.id);
    const rev = store.commitRevision({
      section_id: section.id,
      content: "We are proven.",
      author: { by: "agent", agent: "drafting" },
    });
    const claim = store.addClaim({
      section_id: section.id,
      anchor: { revision_id: rev.id, start: 0, end: 14 },
      text: "We are proven.",
    });
    store.verifier().setVerificationStatus(claim.id, "unsupported");
    const theme = store.createTheme({ pursuit_id: pursuit, kind: "theme", text: "Speed" });
    store.lockTheme(theme.id, USER);
    store.orchestrator().setStage(pursuit, "outline");

    const dump = store.exportPursuit(pursuit);

    // Rehydrate into a brand-new store.
    const restored = new GraphStore();
    restored.importPursuit(dump);

    // Guarded fields survived intact.
    expect(restored.getPursuit(pursuit)?.stage).toBe("outline");
    expect(restored.getClaim(claim.id)?.verification_status).toBe("unsupported");
    expect(restored.getTheme(theme.id)?.status).toBe("locked");

    // Content + provenance survived.
    expect(restored.getRevision(rev.id)?.content).toBe("We are proven.");
    expect(restored.getNode(node.id)?.title).toBe("Human Approach");
    expect(restored.outlineNodeOrigin(node.id)).toBe("human");
    expect(restored.findOutlineNodeByTemplateKey(pursuit, "approach")?.id).toBe(node.id);

    // Restored records are still frozen — guards remain in force.
    expect(() =>
      // @ts-expect-error verification_status excluded from the patch type
      restored.updateClaim(claim.id, { verification_status: "verified" }),
    ).toThrow(GraphError);

    // Id permanence: a fresh mint never collides with the deleted node's id.
    const fresh = restored.addNode({ pursuit_id: pursuit, order: 2, title: "New" });
    expect(fresh.id).not.toBe(deleted.id);
    expect(fresh.id).not.toBe(node.id);
  });
});

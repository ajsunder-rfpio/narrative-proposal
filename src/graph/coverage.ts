import type {
  Claim,
  CoverageStatus,
  OutlineNode,
  OutlineNodeId,
  RequirementId,
  RequirementMapping,
  Section,
  SectionId,
} from "./types.ts";

/**
 * Read-only slice of the graph that coverage derivation needs. The store
 * implements this; coverage.ts stays a pure function with no store dependency.
 */
export interface CoverageView {
  mappingsForRequirement(requirementId: RequirementId): readonly RequirementMapping[];
  node(nodeId: OutlineNodeId): OutlineNode | undefined;
  sectionForNode(nodeId: OutlineNodeId): Section | undefined;
  claimsForSection(sectionId: SectionId): readonly Claim[];
}

/**
 * Compute Requirement.coverage_status. This is the ONLY place the value exists;
 * it is never stored on a Requirement and no agent writes it
 * (object-model.md, "Coverage is computed, never asserted").
 *
 * The ladder, low to high:
 *   unmapped   — no RequirementMapping references it.
 *   mapped     — mapped to node(s), but none yet hold drafted content.
 *   addressed  — at least one mapped node has a current revision (prose exists),
 *                but its supporting claims are not all verified.
 *   verified   — addressed, and every claim in the addressing sections is
 *                verified (and there is at least one such claim to verify).
 *
 * Derived purely from mappings, section content/status, and claim verification —
 * exactly the three inputs the spec names.
 */
export function computeCoverageStatus(
  requirementId: RequirementId,
  view: CoverageView,
): CoverageStatus {
  const mappings = view.mappingsForRequirement(requirementId);
  if (mappings.length === 0) return "unmapped";

  const addressingSections: Section[] = [];
  for (const mapping of mappings) {
    const node = view.node(mapping.outline_node_id);
    if (!node || node.status === "empty") continue;
    const section = view.sectionForNode(mapping.outline_node_id);
    if (section && section.current_revision_id !== null) {
      addressingSections.push(section);
    }
  }

  if (addressingSections.length === 0) return "mapped";

  const claims = addressingSections.flatMap((section) =>
    view.claimsForSection(section.id),
  );

  // "verified" requires evidence that was actually checked: at least one claim,
  // and all of them verified. Addressed-with-no-claims stays "addressed".
  if (claims.length > 0 && claims.every((c) => c.verification_status === "verified")) {
    return "verified";
  }

  return "addressed";
}

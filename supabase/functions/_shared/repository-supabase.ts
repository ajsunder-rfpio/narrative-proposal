// Deno-only. Supabase-backed implementation of GraphRepository.
//
// load() reads the pursuit's rows and hydrates a fresh GraphStore via
// importPursuit; save() dehydrates via exportPursuit and upserts the rows.
// Records are stored as JSONB (`data`) with a few extracted key columns for
// foreign keys and indexing — the round-trip fidelity is guaranteed by the
// export/import seam (covered in the graph suite). Column-per-field
// normalization is a follow-up; the seam already round-trips losslessly.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GraphStore, type PursuitExport } from "../../../src/graph/store.ts";
import type { PursuitId } from "../../../src/graph/types.ts";
import type { GraphRepository } from "./repository.ts";

// deno-lint-ignore no-explicit-any
type Row = any;

async function rowsBy(
  client: SupabaseClient,
  table: string,
  match: Record<string, unknown>,
): Promise<Row[]> {
  const { data, error } = await client.from(table).select("*").match(match);
  if (error) throw new Error(`load ${table}: ${error.message}`);
  return data ?? [];
}

async function rowsIn(
  client: SupabaseClient,
  table: string,
  column: string,
  values: string[],
): Promise<Row[]> {
  if (values.length === 0) return [];
  const { data, error } = await client.from(table).select("*").in(column, values);
  if (error) throw new Error(`load ${table}: ${error.message}`);
  return data ?? [];
}

async function upsert(
  client: SupabaseClient,
  table: string,
  rows: Row[],
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await client.from(table).upsert(rows);
  if (error) throw new Error(`save ${table}: ${error.message}`);
}

export class SupabaseGraphRepository implements GraphRepository {
  constructor(private readonly client: SupabaseClient) {}

  async load(pursuitId: PursuitId): Promise<GraphStore> {
    const store = new GraphStore();
    const c = this.client;

    const [pursuitRow] = await rowsBy(c, "pursuits", { id: pursuitId });
    if (!pursuitRow) return store; // nothing persisted yet

    const orgId = pursuitRow.data.org_id as string;
    const [
      intake,
      requirements,
      mappings,
      nodes,
      sections,
      revisions,
      themes,
      claims,
      citations,
      gens,
      snaps,
      reports,
      ctxRow,
      idRow,
      assets,
    ] = await Promise.all([
      rowsBy(c, "intake_sources", { pursuit_id: pursuitId }),
      rowsBy(c, "requirements", { pursuit_id: pursuitId }),
      rowsBy(c, "requirement_mappings", { pursuit_id: pursuitId }),
      rowsBy(c, "outline_nodes", { pursuit_id: pursuitId }),
      rowsBy(c, "sections", { pursuit_id: pursuitId }),
      rowsBy(c, "section_revisions", { pursuit_id: pursuitId }),
      rowsBy(c, "win_themes", { pursuit_id: pursuitId }),
      rowsBy(c, "claims", { pursuit_id: pursuitId }),
      rowsBy(c, "citations", { pursuit_id: pursuitId }),
      rowsBy(c, "generation_records", { pursuit_id: pursuitId }),
      rowsBy(c, "pursuit_snapshots", { pursuit_id: pursuitId }),
      rowsBy(c, "evaluator_reports", { pursuit_id: pursuitId }),
      rowsBy(c, "pursuit_contexts", { pursuit_id: pursuitId }),
      rowsBy(c, "id_state", { pursuit_id: pursuitId }),
      rowsBy(c, "assets", { org_id: orgId }),
    ]);
    const passages = await rowsIn(
      c,
      "passages",
      "asset_id",
      assets.map((a) => a.id as string),
    );

    const dump: PursuitExport = {
      pursuit: pursuitRow.data,
      intake_sources: intake.map((r) => r.data),
      requirements: requirements.map((r) => r.data),
      requirement_mappings: mappings.map((r) => r.data),
      outline_nodes: nodes.map((r) => ({
        node: r.data,
        origin: r.origin ?? null,
        template_key: r.template_key ?? null,
      })),
      sections: sections.map((r) => r.data),
      section_revisions: revisions.map((r) => r.data),
      win_themes: themes.map((r) => r.data),
      claims: claims.map((r) => r.data),
      citations: citations.map((r) => r.data),
      assets: assets.map((r) => r.data),
      passages: passages.map((r) => r.data),
      generation_records: gens.map((r) => r.data),
      snapshots: snaps.map((r) => r.data),
      evaluator_reports: reports.map((r) => r.data),
      pursuit_context: ctxRow[0]?.data ?? null,
      id_state: idRow[0]
        ? { counter: idRow[0].counter, retired: idRow[0].retired ?? [] }
        : { counter: 0, retired: [] },
    };
    store.importPursuit(dump);
    return store;
  }

  async save(pursuitId: PursuitId, store: GraphStore): Promise<void> {
    const c = this.client;
    const d = store.exportPursuit(pursuitId);
    const key = (data: { id: string }) => ({ id: data.id, pursuit_id: pursuitId, data });

    await upsert(c, "pursuits", [
      { id: d.pursuit.id, org_id: d.pursuit.org_id, data: d.pursuit },
    ]);
    await upsert(c, "intake_sources", d.intake_sources.map(key));
    await upsert(c, "requirements", d.requirements.map(key));
    await upsert(c, "requirement_mappings", d.requirement_mappings.map(key));
    await upsert(
      c,
      "outline_nodes",
      d.outline_nodes.map((e) => ({
        id: e.node.id,
        pursuit_id: pursuitId,
        origin: e.origin,
        template_key: e.template_key,
        data: e.node,
      })),
    );
    await upsert(
      c,
      "sections",
      d.sections.map((s) => ({ id: s.id, pursuit_id: pursuitId, node_id: s.node_id, data: s })),
    );
    await upsert(
      c,
      "section_revisions",
      d.section_revisions.map((r) => ({
        id: r.id,
        pursuit_id: pursuitId,
        section_id: r.section_id,
        data: r,
      })),
    );
    await upsert(c, "win_themes", d.win_themes.map(key));
    await upsert(
      c,
      "claims",
      d.claims.map((cl) => ({ id: cl.id, pursuit_id: pursuitId, section_id: cl.section_id, data: cl })),
    );
    await upsert(
      c,
      "citations",
      d.citations.map((ci) => ({ id: ci.id, pursuit_id: pursuitId, claim_id: ci.claim_id, data: ci })),
    );
    await upsert(
      c,
      "assets",
      d.assets.map((a) => ({ id: a.id, org_id: a.org_id, data: a })),
    );
    await upsert(
      c,
      "passages",
      d.passages.map((p) => ({ id: p.id, asset_id: p.asset_id, data: p })),
    );
    await upsert(c, "generation_records", d.generation_records.map(key));
    await upsert(c, "pursuit_snapshots", d.snapshots.map(key));
    await upsert(c, "evaluator_reports", d.evaluator_reports.map(key));
    if (d.pursuit_context) {
      await upsert(c, "pursuit_contexts", [
        { pursuit_id: pursuitId, data: d.pursuit_context },
      ]);
    }
    await upsert(c, "id_state", [
      { pursuit_id: pursuitId, counter: d.id_state.counter, retired: d.id_state.retired },
    ]);
  }
}

import { GraphStore } from "../../../src/graph/store";
import type { PursuitId } from "../../../src/graph/types";

// The persistence abstraction the handlers depend on. Two implementations:
//   - InMemoryGraphRepository (here) — dev/local, and the seam handler tests
//     inject mocks against.
//   - SupabaseGraphRepository (repository-supabase.ts, Deno) — production.
//
// load() hydrates a fresh synchronous GraphStore from durable rows; save()
// dehydrates it back. The store stays synchronous (its invariants are enforced
// synchronously and agents call it without awaiting); the async boundary lives
// here, at load/run/save — exactly the "load graph state ... persist" shape the
// edge handlers use.

export interface GraphRepository {
  load(pursuitId: PursuitId): Promise<GraphStore>;
  save(pursuitId: PursuitId, store: GraphStore): Promise<void>;
}

/** Process-memory repository. Handy for local `functions serve` without a DB. */
export class InMemoryGraphRepository implements GraphRepository {
  private readonly stores = new Map<string, GraphStore>();

  async load(pursuitId: PursuitId): Promise<GraphStore> {
    return this.stores.get(pursuitId) ?? new GraphStore();
  }

  async save(pursuitId: PursuitId, store: GraphStore): Promise<void> {
    this.stores.set(pursuitId, store);
  }
}

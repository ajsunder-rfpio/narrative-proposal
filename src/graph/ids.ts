import type { Id } from "./types";

/**
 * Monotonic, per-store id minting.
 *
 * OutlineNode IDs are the Word add-in's permanent contract: stable, never
 * reused, surviving rename and reorder (object-model.md, "Node identity is the
 * Word contract"). This generator guarantees the "never reused" half — every
 * mint is strictly increasing and retired ids are refused for reissue. The
 * "stable across rename/reorder" half is the store's job: those operations
 * return records with the same id.
 *
 * Ids are deterministic (counter-based, no clock or randomness) so graph tests
 * and fixture pursuits are reproducible.
 */
export class IdFactory {
  private counter = 0;
  private readonly retired = new Set<string>();

  /** Mint a fresh, never-before-issued id with the given type prefix. */
  mint<T extends string>(prefix: T): Id<T> {
    let candidate: string;
    do {
      this.counter += 1;
      candidate = `${prefix}_${this.counter}`;
    } while (this.retired.has(candidate));
    return candidate as Id<T>;
  }

  /**
   * Record an id as permanently spent. A retired id is never minted again, so a
   * deleted OutlineNode's id can never resurface on a different node.
   */
  retire(id: string): void {
    this.retired.add(id);
  }

  /** True once `retire` has seen this id. */
  isRetired(id: string): boolean {
    return this.retired.has(id);
  }
}

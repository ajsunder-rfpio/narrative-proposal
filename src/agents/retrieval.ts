import type { Asset, Passage } from "../graph/types";

// Minimal retrieval seam over a fixture library. This is the INTERFACE the
// Drafting agent depends on; retrieval *quality* (embeddings, real RAG) is a
// later branch. A keyword overlap scorer is deliberately dumb but deterministic.

export interface RetrievedPassage {
  readonly passage: Passage;
  readonly asset: Asset;
  readonly score: number;
}

export interface Retriever {
  retrieve(query: string, opts?: { limit?: number }): RetrievedPassage[];
}

export interface LibraryEntry {
  readonly asset: Asset;
  readonly passages: readonly Passage[];
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

/**
 * In-memory fixture library that doubles as a keyword Retriever. Score is the
 * number of distinct query tokens present in a passage; passages with zero
 * overlap are dropped, so an off-topic or empty query yields nothing — which is
 * exactly what drives the Drafting agent's gap-marker path.
 */
export class InMemoryLibrary implements Retriever {
  private readonly entries: LibraryEntry[];
  private readonly assetByPassage = new Map<string, Asset>();

  constructor(entries: readonly LibraryEntry[] = []) {
    this.entries = [...entries];
    for (const entry of this.entries) {
      for (const passage of entry.passages) {
        this.assetByPassage.set(passage.id, entry.asset);
      }
    }
  }

  retrieve(query: string, opts: { limit?: number } = {}): RetrievedPassage[] {
    const limit = opts.limit ?? 5;
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];

    const scored: RetrievedPassage[] = [];
    for (const entry of this.entries) {
      for (const passage of entry.passages) {
        const passageTokens = new Set(tokenize(passage.text));
        let score = 0;
        for (const token of queryTokens) {
          if (passageTokens.has(token)) score += 1;
        }
        if (score > 0) {
          scored.push({ passage, asset: entry.asset, score });
        }
      }
    }

    // Deterministic order: score desc, then passage id for stable ties.
    scored.sort((a, b) =>
      b.score - a.score || a.passage.id.localeCompare(b.passage.id),
    );
    return scored.slice(0, limit);
  }
}

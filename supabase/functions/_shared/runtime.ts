// Deno-only. Builds the real dependencies the entrypoints inject into the thin
// handlers: Supabase repository, JWT verifier, Anthropic LLM, and config.

import { serviceClient, makeTokenVerifier } from "./supabase-client.ts";
import { SupabaseGraphRepository } from "./repository-supabase.ts";
import { loadConfig, anthropicApiKey } from "./config.ts";
import { AnthropicLLM } from "../../../src/agents/anthropic-llm.ts";
import { InMemoryLibrary, type Retriever } from "../../../src/agents/retrieval.ts";
import type { SourceContentReader } from "../../../src/agents/intake.ts";
import type { GraphStore } from "../../../src/graph/store.ts";
import type { Asset, Passage } from "../../../src/graph/types.ts";

export function baseRuntime() {
  const client = serviceClient();
  const config = loadConfig();
  return {
    repository: new SupabaseGraphRepository(client),
    verifyToken: makeTokenVerifier(client),
    llm: new AnthropicLLM({ apiKey: anthropicApiKey(), model: config.model }),
    config,
  };
}

// The Drafting agent needs a Retriever over the pursuit's library. Retrieval
// quality is a later branch; this builds the existing keyword retriever from the
// assets/passages hydrated into the store.
export function retrieverFor(store: GraphStore): Retriever {
  const grouped = new Map<string, { asset: Asset; passages: Passage[] }>();
  for (const asset of store.listAssets()) {
    grouped.set(asset.id, { asset, passages: [] });
  }
  for (const passage of store.listPassages()) {
    grouped.get(passage.asset_id)?.passages.push(passage);
  }
  return new InMemoryLibrary([...grouped.values()]);
}

// Placeholder: production ingestion of IntakeSource content (fetching by
// `uri` from storage) is a follow-up. The interface seam is wired here.
export const sourceReader: SourceContentReader = { read: () => "" };

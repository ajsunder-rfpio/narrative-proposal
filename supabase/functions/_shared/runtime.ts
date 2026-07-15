// Deno-only. Builds the real dependencies the entrypoints inject into the thin
// handlers: Supabase repository, JWT verifier, Anthropic LLM, and config.
//
// Construction is LAZY. Nothing that reads env is built at module load — the
// entrypoints call baseRuntime() at import, but it only wires closures. The
// env-backed pieces are constructed on first use:
//   - the Supabase client only when a token is actually verified (which the
//     handler does AFTER its header check, so an unauthenticated request never
//     touches env);
//   - the Anthropic LLM only when the agent makes its first call (i.e. after
//     authentication).
// A missing env var therefore throws inside the handler's try/catch and becomes
// a clean 500 JSON naming the var, never a worker crash at import time.

import { serviceClient, makeTokenVerifier } from "./supabase-client.ts";
import { SupabaseGraphRepository } from "./repository-supabase.ts";
import { loadConfig, anthropicApiKey } from "./config.ts";
import type { EdgeConfig } from "./handlers.ts";
import type { GraphRepository } from "./repository.ts";
import { AnthropicLLM } from "../../../src/agents/anthropic-llm.ts";
import { InMemoryLibrary, type Retriever } from "../../../src/agents/retrieval.ts";
import type {
  LLM,
  LLMRequest,
  LLMResponse,
} from "../../../src/agents/fake-llm.ts";
import type { SourceContentReader } from "../../../src/agents/intake.ts";
import type { GraphStore } from "../../../src/graph/store.ts";
import type { Asset, Passage, PursuitId } from "../../../src/graph/types.ts";

/** Build once, on first call. Deferred env access lives inside `factory`. */
function once<T>(factory: () => T): () => T {
  let value: T;
  let built = false;
  return () => {
    if (!built) {
      value = factory();
      built = true;
    }
    return value;
  };
}

export interface BaseRuntime {
  repository: GraphRepository;
  verifyToken: (token: string) => Promise<{ userId: string } | null>;
  llm: LLM;
  config: EdgeConfig;
}

export function baseRuntime(): BaseRuntime {
  // loadConfig only reads optional vars (with defaults) — safe at import.
  const config = loadConfig();

  // Env-reading singletons, deferred to first use.
  const client = once(() => serviceClient());
  const realLLM = once(
    () => new AnthropicLLM({ apiKey: anthropicApiKey(), model: config.model }),
  );

  // The verifier closure is only INVOKED by requireAuth after its header check,
  // so a request with no bearer token never constructs the Supabase client.
  const verifyToken = (token: string) => makeTokenVerifier(client())(token);

  // Repository + LLM are only used during the work phase, after authentication.
  const repository: GraphRepository = {
    load: (id: PursuitId) => new SupabaseGraphRepository(client()).load(id),
    save: (id: PursuitId, store: GraphStore) =>
      new SupabaseGraphRepository(client()).save(id, store),
  };
  const llm: LLM = {
    complete: (request: LLMRequest): Promise<LLMResponse> =>
      realLLM().complete(request),
  };

  return { repository, verifyToken, llm, config };
}

// The Drafting agent needs a Retriever over the pursuit's library. Retrieval
// quality is a later branch; this builds the existing keyword retriever from the
// assets/passages hydrated into the store. No env access.
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

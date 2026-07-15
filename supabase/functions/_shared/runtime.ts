// Deno-only. Builds the real dependencies the entrypoints inject into the thin
// handlers: Supabase repository, JWT verifier, Anthropic LLM, source reader, and
// config.
//
// Construction is LAZY. Nothing that reads env is built at module load — the
// entrypoints call baseRuntime() at import, but it only wires closures. The
// env-backed pieces are constructed on first use:
//   - the Supabase client only when a token is actually verified, a graph load
//     runs, or a source is downloaded (all AFTER the handler's header check, so
//     an unauthenticated request never touches env);
//   - the Anthropic LLM only when the agent makes its first call.
// A missing env var therefore throws inside the handler's try/catch and becomes
// a clean 500 JSON naming the var, never a worker crash at import time.

import { unzipSync } from "npm:fflate@0.8.3";
import { serviceClient, makeTokenVerifier } from "./supabase-client.ts";
import { SupabaseGraphRepository } from "./repository-supabase.ts";
import { loadConfig, anthropicApiKey } from "./config.ts";
import type { EdgeConfig } from "./handlers.ts";
import type { GraphRepository } from "./repository.ts";
import { AnthropicLLM } from "../../../src/agents/anthropic-llm.ts";
import { InMemoryLibrary, type Retriever } from "../../../src/agents/retrieval.ts";
import {
  StorageSourceReader,
  type StorageObjectReader,
} from "../../../src/agents/source-reader.ts";
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

// Module-level lazy Supabase client, shared by every env-backed dependency.
// serviceClient() (which reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) runs
// only on first use, never at import.
const lazyClient = once(() => serviceClient());

export interface BaseRuntime {
  repository: GraphRepository;
  verifyToken: (token: string) => Promise<{ userId: string } | null>;
  llm: LLM;
  config: EdgeConfig;
}

export function baseRuntime(): BaseRuntime {
  // loadConfig only reads optional vars (with defaults) — safe at import.
  const config = loadConfig();

  const realLLM = once(
    () => new AnthropicLLM({ apiKey: anthropicApiKey(), model: config.model }),
  );

  // Invoked by requireAuth only after its header check, so a request with no
  // bearer token never constructs the Supabase client.
  const verifyToken = (token: string) =>
    makeTokenVerifier(lazyClient())(token);

  const repository: GraphRepository = {
    load: (id: PursuitId) => new SupabaseGraphRepository(lazyClient()).load(id),
    save: (id: PursuitId, store: GraphStore) =>
      new SupabaseGraphRepository(lazyClient()).save(id, store),
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

// Real source reader over Storage. The download closure builds the Supabase
// client lazily (on first use, after auth) and is only invoked by the Intake
// agent during work — a config error therefore surfaces as a 500, not a crash.
function splitStorageUri(uri: string): { bucket: string; path: string } {
  const slash = uri.indexOf("/");
  if (slash <= 0) throw new Error(`invalid storage uri: ${uri}`);
  return { bucket: uri.slice(0, slash), path: uri.slice(slash + 1) };
}

const storage: StorageObjectReader = {
  async download(uri: string): Promise<Uint8Array> {
    const { bucket, path } = splitStorageUri(uri);
    const { data, error } = await lazyClient().storage.from(bucket).download(path);
    if (error || !data) {
      throw new Error(error?.message ?? `object not found: ${uri}`);
    }
    return new Uint8Array(await data.arrayBuffer());
  },
};

export const sourceReader: SourceContentReader = new StorageSourceReader({
  storage,
  unzip: (bytes) => unzipSync(bytes),
});

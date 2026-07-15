// Edge function: section-draft. Thin — delegates to the Drafting agent module.
import { createSectionDraftHandler } from "../_shared/handlers.ts";
import { baseRuntime, retrieverFor } from "../_shared/runtime.ts";
import { DraftingAgent } from "../../../src/agents/drafting.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

Deno.serve(
  createSectionDraftHandler({
    ...baseRuntime(),
    makeAgent: (d) => new DraftingAgent(d),
    makeRetriever: retrieverFor,
  }),
);

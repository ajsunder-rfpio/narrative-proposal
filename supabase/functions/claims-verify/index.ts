// Edge function: claims-verify. Thin — delegates to the Verifier agent module.
import { createClaimsVerifyHandler } from "../_shared/handlers.ts";
import { baseRuntime } from "../_shared/runtime.ts";
import { VerifierAgent } from "../../../src/agents/verifier.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

Deno.serve(
  createClaimsVerifyHandler({
    ...baseRuntime(),
    makeAgent: (d) => new VerifierAgent(d),
  }),
);

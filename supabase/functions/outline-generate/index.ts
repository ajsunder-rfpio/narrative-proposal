// Edge function: outline-generate. Thin — delegates to the Outline agent module.
import { createOutlineGenerateHandler } from "../_shared/handlers.ts";
import { baseRuntime } from "../_shared/runtime.ts";
import { OutlineAgent } from "../../../src/agents/outline.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

Deno.serve(
  createOutlineGenerateHandler({
    ...baseRuntime(),
    makeAgent: (d) => new OutlineAgent(d),
  }),
);

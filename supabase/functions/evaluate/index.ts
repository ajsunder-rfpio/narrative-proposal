// Edge function: evaluate. Thin — delegates to the Evaluator agent module.
import { createEvaluateHandler } from "../_shared/handlers.ts";
import { baseRuntime } from "../_shared/runtime.ts";
import { EvaluatorAgent } from "../../../src/agents/evaluator";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

Deno.serve(
  createEvaluateHandler({
    ...baseRuntime(),
    makeAgent: (d) => new EvaluatorAgent(d),
  }),
);

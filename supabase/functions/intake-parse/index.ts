// Edge function: intake-parse. Thin — delegates to the shared handler, which
// calls the Intake agent module. No parsing logic here (CLAUDE.md).
import { createIntakeParseHandler } from "../_shared/handlers.ts";
import { baseRuntime, sourceReader } from "../_shared/runtime.ts";
import { IntakeAgent } from "../../../src/agents/intake.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

Deno.serve(
  createIntakeParseHandler({
    ...baseRuntime(),
    makeAgent: (d) => new IntakeAgent(d),
    readSource: sourceReader,
  }),
);

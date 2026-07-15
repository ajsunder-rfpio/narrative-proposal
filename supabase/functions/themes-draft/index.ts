// Edge function: themes-draft. Thin — delegates to the Theme agent module.
import { createThemesDraftHandler } from "../_shared/handlers.ts";
import { baseRuntime } from "../_shared/runtime.ts";
import { ThemeAgent } from "../../../src/agents/theme.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

Deno.serve(
  createThemesDraftHandler({
    ...baseRuntime(),
    makeAgent: (d) => new ThemeAgent(d),
  }),
);

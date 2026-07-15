// Supabase edge function (Deno). THIN handler only: it parses the request shape
// and delegates to the shared module. All logic lives in `../_shared/`, which in
// turn calls into the `agents/` and `graph/` modules. Nothing else belongs here
// (CLAUDE.md: "Edge handlers are thin ... No parsing, drafting, or verification
// logic in handlers").

import {
  handleOrchestrate,
  type OrchestrateRequest,
} from "../_shared/orchestrate.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

Deno.serve(async (req: Request): Promise<Response> => {
  const body = (await req.json()) as OrchestrateRequest;
  const result = handleOrchestrate(body);
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
    status: result.ok ? 200 : 400,
  });
});

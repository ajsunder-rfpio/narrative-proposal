// Shared module for the orchestrate edge function.
//
// Per CLAUDE.md, edge handlers are thin: they call into `agents/` and `graph/`
// modules and nothing else — no parsing, drafting, or verification logic in the
// handler. This is where a handler's work actually lives. At scaffold stage it
// is a placeholder; when the agent layer lands, this module wires the request to
// the Orchestrator (agents/) operating over a GraphStore (graph/), and returns
// its result. The handler stays a one-liner that delegates here.

export interface OrchestrateRequest {
  readonly pursuit_id: string;
  readonly action: string;
}

export interface OrchestrateResult {
  readonly ok: boolean;
  readonly detail: string;
}

export function handleOrchestrate(
  request: OrchestrateRequest,
): OrchestrateResult {
  // TODO(agent-layer): construct/load the GraphStore (graph/) and dispatch to
  // the Orchestrator agent (agents/). No business logic belongs in the handler.
  return {
    ok: true,
    detail: `orchestrate:${request.action} for ${request.pursuit_id} (not yet implemented)`,
  };
}

// Agent layer. Only the test harness exists at this scaffold stage; agent
// implementations (Orchestrator, Intake, Outline, Theme, Drafting, Verifier,
// Evaluator — see docs/spec/narrative-proposal-agent-definitions.md) land later
// and will consume the LLM seam defined here.
export * from "./fake-llm";

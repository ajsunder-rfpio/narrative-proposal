// Deno-only. Reads edge config from the environment. Model and prompt-template
// versions come from config here and are recorded in GenerationRecords by the
// agents (they take these as call inputs) — this is where they're sourced.

import type { EdgeConfig } from "./handlers.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export function loadConfig(): EdgeConfig {
  return {
    // Default to the current Anthropic flagship; overridable per deployment.
    model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-opus-4-8",
    promptTemplateVersion: Deno.env.get("PROMPT_TEMPLATE_VERSION") ?? "v1",
  };
}

export function anthropicApiKey(): string {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  return key;
}

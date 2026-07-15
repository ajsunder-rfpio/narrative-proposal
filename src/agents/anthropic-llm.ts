import type { LLM, LLMRequest, LLMResponse } from "./fake-llm";

// ---------------------------------------------------------------------------
// Production LLM adapter: Anthropic Messages API.
//
// Implements the SAME `LLM` interface the agents already consume (fake-llm.ts),
// so no agent code changes to swap the fakes for this in an edge function. The
// model and prompt-template versions are supplied by config at the edge and
// recorded in GenerationRecords by the agents themselves (they already take
// `model` / `promptTemplateVersion` as call inputs) — this adapter only needs
// the model id to make the API call.
//
// fetch-based (no SDK dependency) so it runs unchanged in Deno edge functions
// and in Node. `fetchImpl` is injectable purely for testing.
// ---------------------------------------------------------------------------

export interface AnthropicLLMConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly baseUrl?: string;
  readonly anthropicVersion?: string;
  readonly fetchImpl?: typeof fetch;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}
interface AnthropicResponseBody {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
}

export class AnthropicLLM implements LLM {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly anthropicVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AnthropicLLMConfig) {
    if (!config.apiKey) throw new Error("AnthropicLLM: apiKey is required");
    if (!config.model) throw new Error("AnthropicLLM: model is required");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 8192;
    this.baseUrl = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // The Messages API takes `system` as a top-level string and `messages` with
    // only user/assistant roles. Fold any system-role messages into `system`.
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
    };
    if (system.length > 0) body.system = system;

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as AnthropicResponseBody;
    if (data.stop_reason === "refusal") {
      throw new Error("Anthropic API refused the request");
    }
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    return { text };
  }
}

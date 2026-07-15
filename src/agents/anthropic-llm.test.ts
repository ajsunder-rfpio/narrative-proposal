import { describe, it, expect } from "vitest";

import { AnthropicLLM } from "./index";
import type { LLM } from "./index";

function fakeFetch(
  capture: { url?: string; init?: RequestInit },
  responseBody: unknown,
  status = 200,
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture.url = url;
    capture.init = init;
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("AnthropicLLM adapter", () => {
  it("implements the LLM interface and extracts text from content blocks", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const llm: LLM = new AnthropicLLM({
      apiKey: "sk-test",
      model: "claude-opus-4-8",
      fetchImpl: fakeFetch(capture, {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
        stop_reason: "end_turn",
      }),
    });

    const res = await llm.complete({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
      purpose: "draft",
    });
    expect(res.text).toBe("Hello world");
  });

  it("posts to the messages endpoint with the required headers and body shape", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const llm = new AnthropicLLM({
      apiKey: "sk-test",
      model: "claude-opus-4-8",
      maxTokens: 1234,
      fetchImpl: fakeFetch(capture, { content: [{ type: "text", text: "ok" }] }),
    });

    await llm.complete({
      messages: [
        { role: "system", content: "sys-a" },
        { role: "system", content: "sys-b" },
        { role: "user", content: "u1" },
      ],
    });

    expect(capture.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = capture.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(capture.init!.body as string);
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.max_tokens).toBe(1234);
    // System-role messages folded into the top-level `system` field.
    expect(body.system).toBe("sys-a\n\nsys-b");
    // Only user/assistant remain in messages.
    expect(body.messages).toEqual([{ role: "user", content: "u1" }]);
    // Opus 4.8 rejects sampling params — the adapter never sends them.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const llm = new AnthropicLLM({
      apiKey: "sk-test",
      model: "claude-opus-4-8",
      fetchImpl: fakeFetch(capture, { error: "boom" }, 500),
    });
    await expect(
      llm.complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/Anthropic API error 500/);
  });

  it("throws when the model refuses", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const llm = new AnthropicLLM({
      apiKey: "sk-test",
      model: "claude-opus-4-8",
      fetchImpl: fakeFetch(capture, { content: [], stop_reason: "refusal" }),
    });
    await expect(
      llm.complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/refused/);
  });
});

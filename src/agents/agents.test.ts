import { describe, it, expect } from "vitest";

import { ScriptedLLM, HallucinatingLLM, type LLMRequest } from "./index";

const REQ: LLMRequest = {
  messages: [{ role: "user", content: "Draft the executive summary." }],
  purpose: "draft",
};

// Placeholder suite: no agent logic exists yet (see index.ts). These tests only
// prove the fake-LLM harness itself is wired and behaves, so real agent contract
// tests can be built on top of it.
describe("fake-LLM harness", () => {
  it("ScriptedLLM returns queued responses in order and records calls", async () => {
    const llm = new ScriptedLLM({ queue: ["first", "second"] });
    expect((await llm.complete(REQ)).text).toBe("first");
    expect((await llm.complete(REQ)).text).toBe("second");
    expect(llm.calls).toHaveLength(2);
  });

  it("ScriptedLLM can answer by purpose", async () => {
    const llm = new ScriptedLLM({ byPurpose: { draft: "grounded prose" } });
    expect((await llm.complete(REQ)).text).toBe("grounded prose");
  });

  it("ScriptedLLM throws loudly when a call is unscripted", async () => {
    const llm = new ScriptedLLM();
    await expect(llm.complete(REQ)).rejects.toThrow(/no scripted response/);
  });

  it("HallucinatingLLM fabricates the same ungrounded claim regardless of prompt", async () => {
    const llm = new HallucinatingLLM();
    const a = await llm.complete(REQ);
    const b = await llm.complete({
      messages: [{ role: "user", content: "totally different prompt" }],
    });
    expect(a.text).toBe(b.text);
    // The whole point of this fake: a confident claim with no grounding behind
    // it. Future Verifier contract tests assert this ends up flagged, not trusted.
    expect(a.text).toMatch(/\d/);
    expect(llm.calls).toHaveLength(2);
  });
});

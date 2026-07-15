import { describe, it, expect, vi } from "vitest";

import { GraphStore } from "../graph";
import type { LLM } from "./index";
import type { OrgId, UserId } from "../graph/types";
import {
  createIntakeParseHandler,
  createOutlineGenerateHandler,
  createThemesDraftHandler,
  createSectionDraftHandler,
  createClaimsVerifyHandler,
  createEvaluateHandler,
} from "../../supabase/functions/_shared/handlers";
import type { GraphRepository } from "../../supabase/functions/_shared/repository";

const ORG = "org_1" as OrgId;
const USER = "user_1" as UserId;

const config = { model: "test-model", promptTemplateVersion: "v-test" };
const llm = {} as unknown as LLM; // never used — agents are mocked
const verifyOk = () => ({ userId: "u1" });

function authedReq(body: unknown): Request {
  return new Request("http://edge/action", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function anonReq(body: unknown): Request {
  return new Request("http://edge/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function repoWith(store: GraphStore): { repo: GraphRepository; saved: { called: boolean } } {
  const saved = { called: false };
  return {
    repo: {
      load: async () => store,
      save: async () => {
        saved.called = true;
      },
    },
    saved,
  };
}

describe("edge handlers reject unauthenticated calls and delegate to the agent module", () => {
  it("intake-parse", async () => {
    const parse = vi.fn().mockResolvedValue({ context: { fields: [] }, dropped: [] });
    const { repo, saved } = repoWith(new GraphStore());
    const handler = createIntakeParseHandler({
      repository: repo,
      verifyToken: verifyOk,
      llm,
      config,
      makeAgent: () => ({ parse }),
      readSource: { read: () => "" },
    });

    const unauth = await handler(anonReq({ pursuit_id: "Pursuit_1" }));
    expect(unauth.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();

    const ok = await handler(authedReq({ pursuit_id: "Pursuit_1" }));
    expect(ok.status).toBe(200);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(saved.called).toBe(true);
    expect(await ok.json()).toMatchObject({ ok: true });
  });

  it("outline-generate", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ nodes: [], created: [], updated: [], preserved: [] });
    const { repo } = repoWith(new GraphStore());
    const handler = createOutlineGenerateHandler({
      repository: repo,
      verifyToken: verifyOk,
      llm,
      config,
      makeAgent: () => ({ generate }),
    });

    const body = { pursuit_id: "Pursuit_1", template: { id: "t", nodes: [] } };
    expect((await handler(anonReq(body))).status).toBe(401);
    expect(generate).not.toHaveBeenCalled();

    const ok = await handler(authedReq(body));
    expect(ok.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("outline-generate 400s without a template (no delegation)", async () => {
    const generate = vi.fn();
    const { repo } = repoWith(new GraphStore());
    const handler = createOutlineGenerateHandler({
      repository: repo,
      verifyToken: verifyOk,
      llm,
      config,
      makeAgent: () => ({ generate }),
    });
    const res = await handler(authedReq({ pursuit_id: "Pursuit_1" }));
    expect(res.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it("themes-draft", async () => {
    const draft = vi.fn().mockResolvedValue({ themes: [] });
    const { repo } = repoWith(new GraphStore());
    const handler = createThemesDraftHandler({
      repository: repo,
      verifyToken: verifyOk,
      llm,
      config,
      makeAgent: () => ({ draft }),
    });
    expect((await handler(anonReq({ pursuit_id: "Pursuit_1" }))).status).toBe(401);
    expect(draft).not.toHaveBeenCalled();

    const ok = await handler(authedReq({ pursuit_id: "Pursuit_1" }));
    expect(ok.status).toBe(200);
    expect(draft).toHaveBeenCalledTimes(1);
  });

  it("section-draft", async () => {
    const store = new GraphStore();
    const pursuit = store.createPursuit({
      org_id: ORG,
      name: "P",
      kind: "proactive_proposal",
      owner_id: USER,
    });
    const node = store.addNode({ pursuit_id: pursuit.id, order: 0, title: "S" });
    const draft = vi
      .fn()
      .mockResolvedValue({ revision: { id: "r" }, claims: [], citations: [], gaps: [] });
    const { repo } = repoWith(store);
    const handler = createSectionDraftHandler({
      repository: repo,
      verifyToken: verifyOk,
      llm,
      config,
      makeAgent: () => ({ draft }),
      makeRetriever: () => ({ retrieve: () => [] }),
    });

    const body = { pursuit_id: pursuit.id, node_id: node.id };
    expect((await handler(anonReq(body))).status).toBe(401);
    expect(draft).not.toHaveBeenCalled();

    const ok = await handler(authedReq(body));
    expect(ok.status).toBe(200);
    expect(draft).toHaveBeenCalledTimes(1);
    // The handler passed the loaded node object into the agent.
    expect(draft.mock.calls[0][0].node.id).toBe(node.id);
  });

  it("claims-verify", async () => {
    const verify = vi
      .fn()
      .mockResolvedValue({ claimId: "Claim_1", status: "verified", layer: "code" });
    const { repo } = repoWith(new GraphStore());
    const handler = createClaimsVerifyHandler({
      repository: repo,
      verifyToken: verifyOk,
      llm,
      config,
      makeAgent: () => ({ verify }),
    });
    const body = { pursuit_id: "Pursuit_1", claim_id: "Claim_1" };
    expect((await handler(anonReq(body))).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();

    const ok = await handler(authedReq(body));
    expect(ok.status).toBe(200);
    expect(verify).toHaveBeenCalledWith("Claim_1");
  });

  it("evaluate", async () => {
    const evaluate = vi.fn().mockResolvedValue({ report: { id: "rep" } });
    const { repo } = repoWith(new GraphStore());
    const handler = createEvaluateHandler({
      repository: repo,
      verifyToken: verifyOk,
      llm,
      config,
      makeAgent: () => ({ evaluate }),
    });
    expect((await handler(anonReq({ pursuit_id: "Pursuit_1" }))).status).toBe(401);
    expect(evaluate).not.toHaveBeenCalled();

    const ok = await handler(authedReq({ pursuit_id: "Pursuit_1" }));
    expect(ok.status).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(1);
    // The evaluator was handed a snapshot the handler created.
    expect(evaluate.mock.calls[0][0].snapshot).toBeDefined();
  });

  it("an invalid token is rejected before any delegation", async () => {
    const parse = vi.fn();
    const { repo } = repoWith(new GraphStore());
    const handler = createIntakeParseHandler({
      repository: repo,
      verifyToken: () => null, // token present but rejected
      llm,
      config,
      makeAgent: () => ({ parse }),
      readSource: { read: () => "" },
    });
    const res = await handler(authedReq({ pursuit_id: "Pursuit_1" }));
    expect(res.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });

  // Mirrors the lazy production runtime: with no env vars, every env-backed
  // dependency throws on first use. The handler must authenticate header-first,
  // so an unauthenticated request 401s without ever touching any of them — and
  // a config error on an authenticated request is a clean 500, not a crash.
  it("returns 401 with zero runtime access when no bearer token is present", async () => {
    const missingEnv = () => {
      throw new Error("ANTHROPIC_API_KEY is not set");
    };
    const verifyToken = vi.fn(() => {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
    });
    const load = vi.fn(missingEnv);
    const parse = vi.fn();
    const handler = createIntakeParseHandler({
      repository: { load, save: async () => {} },
      verifyToken,
      llm: { complete: missingEnv } as unknown as LLM,
      config,
      makeAgent: () => ({ parse }),
      readSource: { read: () => "" },
    });

    const res = await handler(anonReq({ pursuit_id: "Pursuit_1" }));
    expect(res.status).toBe(401);
    // None of the env-backed pieces were constructed or used.
    expect(verifyToken).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("turns a config error on an authenticated request into a clean 500 JSON naming the var", async () => {
    const handler = createIntakeParseHandler({
      repository: {
        load: async () => {
          throw new Error("ANTHROPIC_API_KEY is not set");
        },
        save: async () => {},
      },
      verifyToken: () => ({ userId: "u1" }), // authenticated
      llm,
      config,
      makeAgent: () => ({ parse: vi.fn() }),
      readSource: { read: () => "" },
    });

    const res = await handler(authedReq({ pursuit_id: "Pursuit_1" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ANTHROPIC_API_KEY");
  });
});

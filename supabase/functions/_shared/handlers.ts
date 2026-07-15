import { GraphStore } from "../../../src/graph/store";
import type {
  ClaimId,
  OutlineNodeId,
  PursuitContext,
  PursuitId,
  PursuitSnapshotId,
  StyleGuide,
} from "../../../src/graph/types";
import type { LLM } from "../../../src/agents/fake-llm";
import type { SourceContentReader } from "../../../src/agents/intake";
import type { Retriever } from "../../../src/agents/retrieval";
import type { OutlineTemplate } from "../../../src/agents/outline";
import type { GraphRepository } from "./repository";
import {
  HttpError,
  json,
  readJson,
  requireAuth,
  withErrors,
  type TokenVerifier,
} from "./http";

// ---------------------------------------------------------------------------
// One thin handler per agent action. Each: authenticate -> load graph state ->
// call the agent module -> persist -> return. There is NO parsing, drafting, or
// verification logic here — that all lives in the agent modules (CLAUDE.md:
// "Edge handlers are thin ... No parsing, drafting, or verification logic").
//
// Dependencies are injected so the Deno entrypoints wire real ones (Supabase
// repository, Anthropic LLM, JWT verifier) and the handler tests wire mocks at
// the agent-module boundary.
// ---------------------------------------------------------------------------

/** Model + prompt-template version from config; recorded in GenerationRecords. */
export interface EdgeConfig {
  readonly model: string;
  readonly promptTemplateVersion: string;
}

interface BaseDeps {
  readonly repository: GraphRepository;
  readonly verifyToken: TokenVerifier;
  readonly llm: LLM;
  readonly config: EdgeConfig;
}

// Minimal structural shapes for the injected agents — the real agent classes
// satisfy these; tests pass vi.fn-backed mocks.
type IntakeLike = { parse: (input: unknown) => Promise<{ context: unknown; dropped: unknown }> };
type OutlineLike = { generate: (input: unknown) => Promise<Record<string, unknown>> };
type ThemeLike = { draft: (input: unknown) => Promise<{ themes: unknown }> };
type DraftingLike = { draft: (input: unknown) => Promise<Record<string, unknown>> };
type VerifierLike = { verify: (claimId: ClaimId) => Promise<unknown> };
type EvaluatorLike = { evaluate: (input: unknown) => Promise<{ report: unknown }> };

function pursuitId(body: { pursuit_id?: string }): PursuitId {
  if (!body.pursuit_id) throw new HttpError(400, "pursuit_id required");
  return body.pursuit_id as PursuitId;
}

// --- intake-parse ----------------------------------------------------------

export interface IntakeParseDeps extends BaseDeps {
  makeAgent: (d: { store: GraphStore; llm: LLM }) => IntakeLike;
  readSource: SourceContentReader;
}

export function createIntakeParseHandler(deps: IntakeParseDeps) {
  return withErrors(async (req) => {
    await requireAuth(req, deps.verifyToken);
    const body = await readJson<{ pursuit_id?: string }>(req);
    const pid = pursuitId(body);
    const store = await deps.repository.load(pid);
    const sources = store.listIntakeSources(pid);
    const agent = deps.makeAgent({ store, llm: deps.llm });
    const result = await agent.parse({
      pursuit_id: pid,
      sources,
      reader: deps.readSource,
      promptTemplateVersion: deps.config.promptTemplateVersion,
      model: deps.config.model,
    });
    await deps.repository.save(pid, store);
    return json(200, { ok: true, context: result.context, dropped: result.dropped });
  });
}

// --- outline-generate ------------------------------------------------------

export interface OutlineGenerateDeps extends BaseDeps {
  makeAgent: (d: { store: GraphStore; llm: LLM }) => OutlineLike;
}

export function createOutlineGenerateHandler(deps: OutlineGenerateDeps) {
  return withErrors(async (req) => {
    await requireAuth(req, deps.verifyToken);
    const body = await readJson<{
      pursuit_id?: string;
      template?: OutlineTemplate;
      style_guide?: StyleGuide | null;
    }>(req);
    const pid = pursuitId(body);
    if (!body.template) throw new HttpError(400, "template required");
    const store = await deps.repository.load(pid);
    const context: PursuitContext =
      store.getPursuitContext(pid) ?? {
        pursuit_id: pid,
        fields: [],
        generation_record_id: null,
      };
    const agent = deps.makeAgent({ store, llm: deps.llm });
    const result = await agent.generate({
      pursuit_id: pid,
      context,
      template: body.template,
      styleGuide: body.style_guide ?? null,
      promptTemplateVersion: deps.config.promptTemplateVersion,
      model: deps.config.model,
    });
    await deps.repository.save(pid, store);
    return json(200, {
      ok: true,
      nodes: result.nodes,
      created: result.created,
      updated: result.updated,
      preserved: result.preserved,
    });
  });
}

// --- themes-draft ----------------------------------------------------------

export interface ThemesDraftDeps extends BaseDeps {
  makeAgent: (d: { store: GraphStore; llm: LLM }) => ThemeLike;
}

export function createThemesDraftHandler(deps: ThemesDraftDeps) {
  return withErrors(async (req) => {
    await requireAuth(req, deps.verifyToken);
    const body = await readJson<{ pursuit_id?: string }>(req);
    const pid = pursuitId(body);
    const store = await deps.repository.load(pid);
    const context: PursuitContext =
      store.getPursuitContext(pid) ?? {
        pursuit_id: pid,
        fields: [],
        generation_record_id: null,
      };
    const agent = deps.makeAgent({ store, llm: deps.llm });
    const result = await agent.draft({
      pursuit_id: pid,
      context,
      promptTemplateVersion: deps.config.promptTemplateVersion,
      model: deps.config.model,
    });
    await deps.repository.save(pid, store);
    return json(200, { ok: true, themes: result.themes });
  });
}

// --- section-draft ---------------------------------------------------------

export interface SectionDraftDeps extends BaseDeps {
  makeAgent: (d: { store: GraphStore; llm: LLM; retriever: Retriever }) => DraftingLike;
  makeRetriever: (store: GraphStore) => Retriever;
}

export function createSectionDraftHandler(deps: SectionDraftDeps) {
  return withErrors(async (req) => {
    await requireAuth(req, deps.verifyToken);
    const body = await readJson<{
      pursuit_id?: string;
      node_id?: string;
      style_guide?: StyleGuide | null;
    }>(req);
    const pid = pursuitId(body);
    if (!body.node_id) throw new HttpError(400, "node_id required");
    const store = await deps.repository.load(pid);
    const node = store.getNode(body.node_id as OutlineNodeId);
    if (!node) throw new HttpError(404, `node not found: ${body.node_id}`);
    const lockedThemes = store
      .listThemes(pid)
      .filter((t) => t.status === "locked");
    const retriever = deps.makeRetriever(store);
    const agent = deps.makeAgent({ store, llm: deps.llm, retriever });
    const result = await agent.draft({
      node,
      lockedThemes,
      styleGuide: body.style_guide ?? null,
      promptTemplateVersion: deps.config.promptTemplateVersion,
      model: deps.config.model,
    });
    await deps.repository.save(pid, store);
    return json(200, {
      ok: true,
      revision: result.revision,
      claims: result.claims,
      citations: result.citations,
      gaps: result.gaps,
    });
  });
}

// --- claims-verify ---------------------------------------------------------

export interface ClaimsVerifyDeps extends BaseDeps {
  makeAgent: (d: { store: GraphStore; llm: LLM }) => VerifierLike;
}

export function createClaimsVerifyHandler(deps: ClaimsVerifyDeps) {
  return withErrors(async (req) => {
    await requireAuth(req, deps.verifyToken);
    const body = await readJson<{ pursuit_id?: string; claim_id?: string }>(req);
    const pid = pursuitId(body);
    if (!body.claim_id) throw new HttpError(400, "claim_id required");
    const store = await deps.repository.load(pid);
    const agent = deps.makeAgent({ store, llm: deps.llm });
    const verdict = await agent.verify(body.claim_id as ClaimId);
    await deps.repository.save(pid, store);
    return json(200, { ok: true, verdict });
  });
}

// --- evaluate --------------------------------------------------------------

export interface EvaluateDeps extends BaseDeps {
  makeAgent: (d: { store: GraphStore; llm: LLM }) => EvaluatorLike;
}

export function createEvaluateHandler(deps: EvaluateDeps) {
  return withErrors(async (req) => {
    await requireAuth(req, deps.verifyToken);
    const body = await readJson<{ pursuit_id?: string; snapshot_id?: string }>(req);
    const pid = pursuitId(body);
    const store = await deps.repository.load(pid);
    const snapshot = body.snapshot_id
      ? store.getSnapshot(body.snapshot_id as PursuitSnapshotId)
      : store.createSnapshot({ pursuit_id: pid, label: "evaluation" });
    if (!snapshot) throw new HttpError(404, `snapshot not found: ${body.snapshot_id}`);
    const agent = deps.makeAgent({ store, llm: deps.llm });
    const result = await agent.evaluate({
      snapshot,
      promptTemplateVersion: deps.config.promptTemplateVersion,
      model: deps.config.model,
    });
    await deps.repository.save(pid, store);
    return json(200, { ok: true, report: result.report });
  });
}

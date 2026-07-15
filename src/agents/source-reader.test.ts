import { describe, it, expect } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";

import { GraphStore } from "../graph";
import type { IntakeSource, OrgId, PursuitId, UserId } from "../graph/types";
import {
  StorageSourceReader,
  SourceReadError,
  IntakeAgent,
  ScriptedLLM,
  type StorageObjectReader,
} from "./index";

const ORG = "org_1" as OrgId;
const USER = "user_1" as UserId;

// In-memory storage fake — the seam. Real parsing runs against these bytes.
function memStorage(objects: Record<string, Uint8Array>): StorageObjectReader {
  return {
    async download(uri: string) {
      const bytes = objects[uri];
      if (!bytes) throw new Error(`object not found: ${uri}`);
      return bytes;
    },
  };
}

const unzip = (b: Uint8Array) => unzipSync(b);
function makeReader(objects: Record<string, Uint8Array>) {
  return new StorageSourceReader({ storage: memStorage(objects), unzip });
}

/** A minimal but real .docx: a zip whose word/document.xml holds the text. */
function makeDocx(text: string): Uint8Array {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return zipSync({ "word/document.xml": strToU8(xml) });
}

function src(uri: string): IntakeSource {
  return {
    id: "IntakeSource_x" as IntakeSource["id"],
    pursuit_id: "Pursuit_1" as PursuitId,
    kind: "transcript",
    uri,
    parse_status: "pending",
    parse_error: null,
  };
}

describe("StorageSourceReader: MVP formats through the real parsing path", () => {
  it("reads .txt transcripts/notes", async () => {
    const reader = makeReader({ "b/notes.txt": strToU8("Capture notes: budget ~$200k.") });
    expect(await reader.read(src("b/notes.txt"))).toBe("Capture notes: budget ~$200k.");
  });

  it("reads .csv CRM extracts as raw text", async () => {
    const csv = "name,role\nDana Lee,VP of Growth\n";
    const reader = makeReader({ "b/crm.csv": strToU8(csv) });
    expect(await reader.read(src("b/crm.csv"))).toBe(csv);
  });

  it("reads .docx by unzipping and extracting the text runs", async () => {
    const reader = makeReader({
      "b/t.docx": makeDocx("The customer is Acme Corp and wants faster proposals."),
    });
    expect(await reader.read(src("b/t.docx"))).toBe(
      "The customer is Acme Corp and wants faster proposals.",
    );
  });

  it("reads pasted text from a data: URI (plain and base64)", async () => {
    const reader = makeReader({});
    expect(await reader.read(src("data:text/plain,Pasted%20notes%20here"))).toBe(
      "Pasted notes here",
    );
    const b64 = btoa("Pasted via base64");
    expect(await reader.read(src(`data:text/plain;base64,${b64}`))).toBe(
      "Pasted via base64",
    );
  });

  it("returns empty string for an empty object (the agent decides that's a failure)", async () => {
    const reader = makeReader({ "b/empty.txt": new Uint8Array(0) });
    expect(await reader.read(src("b/empty.txt"))).toBe("");
  });

  it("fails PDF with an explicit reason (not implemented — heavy dependency)", async () => {
    const reader = makeReader({ "b/doc.pdf": strToU8("%PDF-1.4 ...") });
    await expect(reader.read(src("b/doc.pdf"))).rejects.toThrow(SourceReadError);
    await expect(reader.read(src("b/doc.pdf"))).rejects.toThrow(/PDF/);
  });

  it("fails an unknown format with a reason", async () => {
    const reader = makeReader({ "b/x.rtf": strToU8("junk") });
    await expect(reader.read(src("b/x.rtf"))).rejects.toThrow(/unsupported source format/);
  });

  it("fails an unreadable (missing) object with a reason", async () => {
    const reader = makeReader({});
    await expect(reader.read(src("b/missing.txt"))).rejects.toThrow(/could not download/);
  });

  it("fails a corrupt .docx with a reason", async () => {
    const reader = makeReader({ "b/bad.docx": strToU8("not a zip at all") });
    await expect(reader.read(src("b/bad.docx"))).rejects.toThrow(/docx/);
  });
});

// --- Intake through the real reader ----------------------------------------

let tick = 0;
function makeStore() {
  tick = 0;
  return new GraphStore({
    clock: () => `2026-05-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  });
}
function newPursuit(store: GraphStore): PursuitId {
  return store.createPursuit({
    org_id: ORG,
    name: "P",
    kind: "proactive_proposal",
    owner_id: USER,
  }).id;
}

describe("Intake through the real source reader", () => {
  it("grounds facts from .docx and .csv content and marks the sources parsed", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const transcript = store.addIntakeSource({
      pursuit_id: pursuit,
      kind: "transcript",
      uri: "intake-sources/p/transcript.docx",
    });
    const crm = store.addIntakeSource({
      pursuit_id: pursuit,
      kind: "crm_extract",
      uri: "intake-sources/p/crm.csv",
    });
    const reader = makeReader({
      "intake-sources/p/transcript.docx": makeDocx(
        "The customer is Acme Corp and needs faster proposals.",
      ),
      "intake-sources/p/crm.csv": strToU8("name,role\nDana Lee,VP of Growth\n"),
    });

    const intakeJSON = JSON.stringify({
      facts: [
        { key: "customer", value: "Acme Corp", source_id: transcript.id, quote: "The customer is Acme Corp" },
        { key: "stakeholders", value: "Dana Lee, VP of Growth", source_id: crm.id, quote: "Dana Lee,VP of Growth" },
      ],
    });
    const intake = new IntakeAgent({
      store,
      llm: new ScriptedLLM({ byPurpose: { intake: intakeJSON } }),
    });
    const result = await intake.parse({ pursuit_id: pursuit, sources: [transcript, crm], reader });

    expect(store.getIntakeSource(transcript.id)?.parse_status).toBe("parsed");
    expect(store.getIntakeSource(transcript.id)?.parse_error).toBeNull();
    expect(store.getIntakeSource(crm.id)?.parse_status).toBe("parsed");

    const byKey = new Map(result.context.fields.map((f) => [f.key, f]));
    expect(byKey.get("customer")?.status).toBe("found");
    expect(byKey.get("customer")?.facts[0].source.locator).toBe("The customer is Acme Corp");
    expect(byKey.get("stakeholders")?.status).toBe("found");
    expect(byKey.get("competitive_mentions")?.status).toBe("not_found");
  });

  it("unreadable source: parse_status=failed with a reason, grounds nothing, fields not_found", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const bad = store.addIntakeSource({
      pursuit_id: pursuit,
      kind: "transcript",
      uri: "intake-sources/p/missing.txt",
    });
    const reader = makeReader({}); // download throws — object not present

    // The model still proposes a fact citing it; it must be dropped.
    const intakeJSON = JSON.stringify({
      facts: [{ key: "customer", value: "Ghost Corp", source_id: bad.id, quote: "Ghost Corp" }],
    });
    const intake = new IntakeAgent({
      store,
      llm: new ScriptedLLM({ byPurpose: { intake: intakeJSON } }),
    });
    const result = await intake.parse({ pursuit_id: pursuit, sources: [bad], reader });

    const source = store.getIntakeSource(bad.id);
    expect(source?.parse_status).toBe("failed");
    expect(source?.parse_error).toMatch(/could not download/);
    // Nothing grounded; the fabricated fact was dropped.
    expect(result.dropped).toHaveLength(1);
    expect(result.context.fields.every((f) => f.status === "not_found")).toBe(true);
    expect(result.context.fields.flatMap((f) => f.facts)).toHaveLength(0);
  });

  it("empty source: parse_status=failed with 'source is empty', grounds nothing", async () => {
    const store = makeStore();
    const pursuit = newPursuit(store);
    const empty = store.addIntakeSource({
      pursuit_id: pursuit,
      kind: "capture_notes",
      uri: "intake-sources/p/empty.txt",
    });
    const reader = makeReader({ "intake-sources/p/empty.txt": strToU8("   \n\t ") });
    const intakeJSON = JSON.stringify({
      facts: [{ key: "customer", value: "X", source_id: empty.id, quote: " " }],
    });
    const intake = new IntakeAgent({
      store,
      llm: new ScriptedLLM({ byPurpose: { intake: intakeJSON } }),
    });
    const result = await intake.parse({ pursuit_id: pursuit, sources: [empty], reader });

    const source = store.getIntakeSource(empty.id);
    expect(source?.parse_status).toBe("failed");
    expect(source?.parse_error).toBe("source is empty");
    expect(result.context.fields.every((f) => f.status === "not_found")).toBe(true);
  });
});

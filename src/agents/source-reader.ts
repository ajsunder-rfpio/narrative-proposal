import type { IntakeSource } from "../graph/types.ts";
import type { SourceContentReader } from "./intake.ts";

// ---------------------------------------------------------------------------
// Real source reading for the Intake agent. An IntakeSource.uri points at an
// uploaded object in Storage (or is a `data:` URI for pasted text). This reader
// fetches the bytes and decodes them to text per MVP format:
//
//   .txt / .md   transcripts, capture notes  -> UTF-8 text
//   .csv         CRM extracts                -> UTF-8 text (raw CSV)
//   .docx        transcripts / notes         -> unzip + extract <w:t> runs
//   data: URI    pasted text                 -> decoded inline
//
// PDF is in the intake design's accepted formats but a PDF text extractor pulls
// heavy dependencies into the edge runtime, so it is NOT implemented here — a
// .pdf source fails with an explicit reason (see the options surfaced to the
// maintainer). Unknown formats, missing objects, and empty content all surface
// as failures the Intake agent records; never a silent empty success.
//
// The zip primitive is injected (`unzip`) so this module stays dependency-free
// and runs identically under vitest (Node) and the Deno edge runtime.
// ---------------------------------------------------------------------------

/** Fetch the raw bytes an IntakeSource.uri points at. */
export interface StorageObjectReader {
  download(uri: string): Promise<Uint8Array>;
}

/** Unzip a zip archive into { entryPath -> bytes } (fflate.unzipSync shape). */
export type Unzip = (bytes: Uint8Array) => Record<string, Uint8Array>;

/** Thrown for an unreadable/unsupported source; the message is the failure reason. */
export class SourceReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceReadError";
  }
}

export class StorageSourceReader implements SourceContentReader {
  constructor(
    private readonly deps: { storage: StorageObjectReader; unzip: Unzip },
  ) {}

  async read(source: IntakeSource): Promise<string> {
    const uri = source.uri;
    if (uri.startsWith("data:")) return decodeDataUri(uri);

    const ext = extname(uri);
    if (ext === ".pdf") {
      throw new SourceReadError(
        "PDF sources are not supported yet (would require a heavy PDF text extractor in the edge runtime)",
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.deps.storage.download(uri);
    } catch (err) {
      throw new SourceReadError(
        `could not download source: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    switch (ext) {
      case ".txt":
      case ".md":
      case ".csv":
        return decodeUtf8(bytes);
      case ".docx":
        return this.readDocx(bytes);
      default:
        throw new SourceReadError(`unsupported source format: "${ext || "(none)"}"`);
    }
  }

  private readDocx(bytes: Uint8Array): string {
    let entries: Record<string, Uint8Array>;
    try {
      entries = this.deps.unzip(bytes);
    } catch (err) {
      throw new SourceReadError(
        `not a valid .docx (unzip failed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const doc = entries["word/document.xml"];
    if (!doc) {
      throw new SourceReadError("not a valid .docx (missing word/document.xml)");
    }
    return extractDocxText(decodeUtf8(doc));
  }
}

// --- format helpers --------------------------------------------------------

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Last path extension, lowercased (query/hash stripped). "" if none. */
export function extname(uri: string): string {
  const base = uri.split(/[?#]/)[0].split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** RFC 2397 data: URI -> text (pasted text). Supports base64 and percent-encoded. */
export function decodeDataUri(uri: string): string {
  const comma = uri.indexOf(",");
  if (comma < 0) throw new SourceReadError("malformed data: URI");
  const meta = uri.slice("data:".length, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return decodeUtf8(bytes);
  }
  return decodeURIComponent(payload);
}

/**
 * Extract readable text from a Word document.xml: the text of every <w:t> run,
 * with paragraph (</w:p>) and tab (<w:tab/>) boundaries preserved as whitespace.
 */
export function extractDocxText(documentXml: string): string {
  let out = "";
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<\/w:p>|<w:tab\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(documentXml)) !== null) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    else if (m[0] === "<w:tab/>") out += "\t";
    else out += "\n"; // </w:p>
  }
  return out.trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

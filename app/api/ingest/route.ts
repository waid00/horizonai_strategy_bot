import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md", ".csv"]);
const DATA_SOURCES = [
  { label: "docs", folderPath: path.join(process.cwd(), "docs") },
  { label: "uploads", folderPath: path.join(process.cwd(), "data", "uploads") },
];

type LoadedDocument = {
  sourceFileName: string;
  sourcePath: string;
  content: string;
  metadata: Record<string, unknown>;
};

type Chunk = {
  content: string;
  metadata: Record<string, unknown>;
};

let _supabase: SupabaseClient | null = null;
let _openai: OpenAI | null = null;
let _pdfParseClass: null | (new (params: { data: Uint8Array | Buffer }) => {
  getText: () => Promise<{ text: string }>;
  destroy: () => Promise<void>;
}) = null;
let _extractRawText: null | ((params: { path: string }) => Promise<{ value: string }>) = null;

function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _supabase;
}

function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  }
  return _openai;
}

async function getPDFParseClass() {
  if (_pdfParseClass) {
    return _pdfParseClass;
  }

  const pdfModule = await import("pdf-parse");
  const PDFParseCtor = (pdfModule as unknown as {
    PDFParse?: new (params: { data: Uint8Array | Buffer }) => {
      getText: () => Promise<{ text: string }>;
      destroy: () => Promise<void>;
    };
  }).PDFParse;

  if (!PDFParseCtor) {
    throw new Error("pdf-parse does not expose PDFParse in this runtime");
  }

  _pdfParseClass = PDFParseCtor;
  return _pdfParseClass;
}

async function getMammothExtractRawText() {
  if (_extractRawText) {
    return _extractRawText;
  }

  const mammothModule = await import("mammoth");
  const extractRawText = (mammothModule as unknown as {
    extractRawText?: (params: { path: string }) => Promise<{ value: string }>;
    default?: { extractRawText?: (params: { path: string }) => Promise<{ value: string }> };
  }).extractRawText
    ?? (mammothModule as unknown as {
      default?: { extractRawText?: (params: { path: string }) => Promise<{ value: string }> };
    }).default?.extractRawText;

  if (!extractRawText) {
    throw new Error("mammoth extractRawText is not available in this runtime");
  }

  _extractRawText = extractRawText;
  return _extractRawText;
}

/**
 * Detects the field delimiter used in a CSV file by inspecting the first line.
 * Preference order: tab → semicolon → comma.
 * European CSV exports (e.g. Czech locale) commonly use semicolons; tab-separated
 * exports are also frequent.  Comma is the fallback for standard RFC 4180 files.
 */
function detectCsvDelimiter(firstLine: string): string {
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const semicolonCount = (firstLine.match(/;/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;

  if (tabCount > 0 && tabCount >= semicolonCount && tabCount >= commaCount) return "\t";
  if (semicolonCount > 0 && semicolonCount >= commaCount) return ";";
  return ",";
}

/**
 * Parses a single CSV row using the given delimiter, handling double-quoted
 * fields that may contain the delimiter character or newlines.
 */
function parseCsvRow(row: string, delimiter = ","): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === '"') {
      // Handle escaped double-quotes ("") inside a quoted field
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Converts CSV text into a human-readable, semantically rich format so that
 * embeddings capture the relationship between column names and their values.
 *
 * Automatically detects the delimiter (tab, semicolon, or comma) from the
 * first non-empty line so the function works with standard CSV, European
 * semicolon-separated, and tab-separated exports alike.
 *
 * Example input (semicolon-delimited):
 *   KPI;Current State;Target State
 *   Active Digital Clients;55%;80%
 *   Cost-to-Income;60%;40%
 *
 * Example output:
 *   KPI: Active Digital Clients | Current State: 55% | Target State: 80%
 *   KPI: Cost-to-Income | Current State: 60% | Target State: 40%
 */
function csvToDescriptiveText(csvContent: string): string {
  const lines = csvContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    // Single-line CSV or empty – return as-is
    return csvContent;
  }

  const delimiter = detectCsvDelimiter(lines[0]);
  const headers = parseCsvRow(lines[0], delimiter);
  if (headers.length === 0) return csvContent;

  const rows: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvRow(lines[i], delimiter);
    if (values.length === 0) continue;

    // Build "Header: Value" pairs; skip pairs where the value is empty
    const pairs: string[] = [];
    for (let col = 0; col < headers.length; col++) {
      const header = headers[col].trim();
      const value = (values[col] ?? "").trim();
      if (header && value) {
        pairs.push(`${header}: ${value}`);
      }
    }

    if (pairs.length > 0) {
      rows.push(pairs.join(" | "));
    }
  }

  return rows.length > 0 ? rows.join("\n") : csvContent;
}

function chunkDocument(doc: LoadedDocument, maxChunkChars = 900): Chunk[] {
  const paragraphs = doc.content
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: Chunk[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n${paragraph}` : paragraph;
    if (candidate.length > maxChunkChars && current.length > 0) {
      chunks.push({ content: current.trim(), metadata: doc.metadata });
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push({ content: current.trim(), metadata: doc.metadata });
  }

  return chunks;
}

async function generateEmbeddings(texts: string[]) {
  const response = await getOpenAI().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((item) => item.embedding);
}

async function listFiles(folderPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(folderPath, entry.name));
  } catch {
    return [];
  }
}

async function loadDocument(fullPath: string, sourceLabel: string): Promise<LoadedDocument | null> {
  const sourceFileName = path.basename(fullPath);
  const extension = path.extname(sourceFileName).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return null;
  }

  try {
    let content = "";

    if (extension === ".pdf") {
      const PDFParse = await getPDFParseClass();
      const buffer = await fs.readFile(fullPath);
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      await parser.destroy();
      content = parsed.text;
    } else if (extension === ".docx") {
      const extractRawText = await getMammothExtractRawText();
      const result = await extractRawText({ path: fullPath });
      content = result.value;
    } else {
      content = await fs.readFile(fullPath, "utf-8");
    }

    // For CSV files we must preserve tab characters until after the CSV-to-prose
    // conversion, because tab is a valid field delimiter in many European exports.
    // Collapsing tabs to spaces first would make tab-delimited files unparseable.
    let normalized: string;
    if (extension === ".csv") {
      // Step 1: normalise line endings only (keep tabs).
      const csvRaw = content
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      // Step 2: convert CSV to human-readable key-value prose so that embeddings
      // capture the relationship between column headers and values
      // (e.g. "KPI: Active Digital Clients | Current State: 55% | Target State: 80%").
      const csvProse = csvToDescriptiveText(csvRaw);
      // Step 3: apply whitespace normalisation to the resulting prose.
      normalized = csvProse
        .replace(/\t/g, " ")
        .replace(/[ ]{2,}/g, " ")
        .trim();
    } else {
      normalized = content
        .replace(/\r\n/g, "\n")
        .replace(/\t/g, " ")
        .replace(/[ ]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    if (normalized.length < 50) {
      return null;
    }

    const hash = crypto.createHash("sha256").update(normalized).digest("hex");

    return {
      sourceFileName,
      sourcePath: fullPath,
      content: normalized,
      metadata: {
        domain: "Custom",
        source: sourceFileName,
        source_hash: hash,
        source_namespace: sourceLabel,
        tags: [extension.slice(1)],
      },
    };
  } catch {
    return null;
  }
}

async function clearSourceHash(hash: string) {
  const { error } = await getSupabase()
    .from("documents")
    .delete()
    .filter("metadata->>source_hash", "eq", hash);

  if (error) {
    throw new Error(`Failed to clear old chunks for hash ${hash}: ${error.message}`);
  }
}

async function insertBatch(chunks: Array<Chunk & { embedding: number[] }>) {
  const { error } = await getSupabase().from("documents").insert(
    chunks.map((chunk) => ({
      content: chunk.content,
      embedding: chunk.embedding,
      metadata: chunk.metadata,
    }))
  );

  if (error) {
    throw new Error(`Supabase insert error: ${error.message}`);
  }
}

export async function POST() {
  const missingEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"].filter(
    (name) => !process.env[name]
  );

  if (missingEnv.length > 0) {
    return NextResponse.json(
      { error: `Missing required environment variables: ${missingEnv.join(", ")}` },
      { status: 500 }
    );
  }

  const logs: string[] = [];

  try {
    const loadedDocuments: LoadedDocument[] = [];

    for (const source of DATA_SOURCES) {
      const files = await listFiles(source.folderPath);
      logs.push(`Scanning ${source.label}: ${files.length} file(s)`);

      for (const file of files) {
        const loaded = await loadDocument(file, source.label);
        if (loaded) {
          loadedDocuments.push(loaded);
        }
      }
    }

    if (loadedDocuments.length === 0) {
      return NextResponse.json({
        ok: true,
        logs: [...logs, "No supported documents found to ingest."],
        filesProcessed: 0,
        chunksInserted: 0,
      });
    }

    const uniqueHashes = new Set(
      loadedDocuments.map((doc) => String(doc.metadata.source_hash ?? ""))
    );

    for (const hash of uniqueHashes) {
      if (hash) {
        await clearSourceHash(hash);
      }
    }

    const allChunks = loadedDocuments.flatMap((doc) => chunkDocument(doc));
    logs.push(`Loaded documents: ${loadedDocuments.length}`);
    logs.push(`Generated chunks: ${allChunks.length}`);

    let inserted = 0;

    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
      const batch = allChunks.slice(i, i + BATCH_SIZE);
      const batchNo = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);

      logs.push(`Embedding batch ${batchNo}/${totalBatches} (${batch.length} chunks)`);

      const embeddings = await generateEmbeddings(batch.map((c) => c.content));
      const chunksWithEmbeddings = batch.map((chunk, idx) => ({
        ...chunk,
        embedding: embeddings[idx],
      }));

      await insertBatch(chunksWithEmbeddings);
      inserted += chunksWithEmbeddings.length;
    }

    logs.push("Ingest finished successfully.");

    return NextResponse.json({
      ok: true,
      logs,
      filesProcessed: loadedDocuments.length,
      chunksInserted: inserted,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        logs,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}

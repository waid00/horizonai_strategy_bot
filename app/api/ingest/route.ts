/**
 * Horizon Bank Strategy Bot – Ingest API Endpoint
 * File: /app/api/ingest/route.ts
 *
 * POST /api/ingest
 *   Runs the full ingestion pipeline over data/uploads/ and streams
 *   progress back to the client as Server-Sent Events (SSE).
 *
 * Pipeline mirrors scripts/ingest.mjs:
 *   1. Load documents from data/uploads/  (.pdf / .docx / .txt)
 *   2. Split each document into chunks (900 chars max)
 *   3. Batch-embed chunks via text-embedding-3-small
 *   4. Upsert chunk rows into the Supabase documents table
 */

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

// Node.js runtime: uses fs, pdf-parse, mammoth
export const runtime = "nodejs";

// ─── Paths & constants ────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");
const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocChunk {
  content: string;
  metadata: { domain: string; source: string; tags: string[] };
}

interface ChunkWithEmbedding extends DocChunk {
  embedding: number[];
}

// ─── Document loading (mirrors load-docs.mjs) ────────────────────────────────

async function loadDocumentsFromUploads(
  send: (msg: string) => void
): Promise<DocChunk[]> {
  // Dynamic requires keep pdf-parse / mammoth out of the edge bundle
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse") as (
    buf: Buffer
  ) => Promise<{ text: string }>;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require("mammoth") as {
    extractRawText: (opts: { path: string }) => Promise<{ value: string }>;
  };

  const files = fs.readdirSync(UPLOADS_DIR).filter((f) => !f.startsWith("."));
  const documents: DocChunk[] = [];

  for (const file of files) {
    const filePath = path.join(UPLOADS_DIR, file);
    const ext = path.extname(file).toLowerCase();
    let content = "";

    try {
      if (ext === ".pdf") {
        const buffer = fs.readFileSync(filePath);
        const parsed = await pdfParse(buffer);
        content = parsed.text;
        send(`📄 Loaded PDF: ${file} (${content.length} chars)`);
      } else if (ext === ".docx") {
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value;
        send(`📄 Loaded DOCX: ${file} (${content.length} chars)`);
      } else if (ext === ".txt") {
        content = fs.readFileSync(filePath, "utf-8");
        send(`📄 Loaded TXT: ${file} (${content.length} chars)`);
      } else {
        send(`⚠️ Skipped unsupported file: ${file}`);
        continue;
      }

      content = content.replace(/\s+/g, " ").trim();

      if (content.length < 50) {
        send(`⚠️ Skipped empty/tiny file: ${file}`);
        continue;
      }

      documents.push({
        content,
        metadata: {
          domain: "Custom",
          source: file,
          tags: [ext.replace(".", "")],
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send(`❌ Failed to load ${file}: ${msg}`);
    }
  }

  return documents;
}

// ─── Chunking (mirrors scripts/ingest.mjs) ───────────────────────────────────

function chunkDocument(doc: DocChunk, maxChunkChars = 900): DocChunk[] {
  const paragraphs = doc.content
    .split("\n")
    .filter((p) => p.trim().length > 0);
  const chunks: DocChunk[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n" + para : para;
    if (candidate.length > maxChunkChars && current.length > 0) {
      chunks.push({ content: current.trim(), metadata: doc.metadata });
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) {
    chunks.push({ content: current.trim(), metadata: doc.metadata });
  }
  return chunks;
}

// ─── Embedding (mirrors scripts/ingest.mjs) ──────────────────────────────────

async function generateEmbeddings(
  openai: OpenAI,
  texts: string[]
): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((item) => item.embedding);
}

// ─── Upsert (mirrors scripts/ingest.mjs) ─────────────────────────────────────

async function upsertChunks(
  supabase: ReturnType<typeof createClient>,
  chunks: ChunkWithEmbedding[]
) {
  const { error } = await supabase.from("documents").insert(
    chunks.map((c) => ({
      content: c.content,
      embedding: c.embedding,
      metadata: c.metadata,
    }))
  );
  if (error) throw new Error(`Supabase insert error: ${error.message}`);
}

// ─── SSE helper ──────────────────────────────────────────────────────────────

function sseEvent(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

// ─── POST handler ────────────────────────────────────────────────────────────

export async function POST(_req: NextRequest) {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const openaiKey = process.env.OPENAI_API_KEY ?? "";

  const stream = new ReadableStream({
    async start(controller) {
      function send(msg: string) {
        controller.enqueue(sseEvent({ msg }));
      }

      try {
        if (!supabaseUrl || !serviceRoleKey || !openaiKey) {
          send(
            "❌ Missing environment variables (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY)."
          );
          controller.enqueue(sseEvent({ done: true, ok: false }));
          controller.close();
          return;
        }

        if (!fs.existsSync(UPLOADS_DIR)) {
          send("⚠️ Uploads folder does not exist. Upload some documents first.");
          controller.enqueue(sseEvent({ done: true, ok: false }));
          controller.close();
          return;
        }

        const supabase = createClient(supabaseUrl, serviceRoleKey);
        const openai = new OpenAI({ apiKey: openaiKey });

        send("🏦 Horizon Bank RAG – Ingestion Pipeline");
        send("📂 Reading documents from: data/uploads/");

        const documents = await loadDocumentsFromUploads(send);

        if (documents.length === 0) {
          send(
            "⚠️ No supported documents found in data/uploads/. Upload .pdf, .docx, or .txt files first."
          );
          controller.enqueue(sseEvent({ done: true, ok: false }));
          controller.close();
          return;
        }

        send(`\n📚 Documents loaded: ${documents.length}`);

        const allChunks = documents.flatMap((doc) => chunkDocument(doc));
        send(`📄 Total chunks after splitting: ${allChunks.length}`);

        const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);

        for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
          const batch = allChunks.slice(i, i + BATCH_SIZE);
          const batchNum = Math.floor(i / BATCH_SIZE) + 1;

          send(
            `⚙️ Batch ${batchNum}/${totalBatches} – embedding ${batch.length} chunks…`
          );

          const texts = batch.map((c) => c.content);
          const embeddings = await generateEmbeddings(openai, texts);

          const chunksWithEmbeddings: ChunkWithEmbedding[] = batch.map(
            (chunk, idx) => ({ ...chunk, embedding: embeddings[idx] })
          );

          await upsertChunks(supabase, chunksWithEmbeddings);
          send(`✅ Batch ${batchNum} upserted.`);

          if (i + BATCH_SIZE < allChunks.length) {
            await new Promise((r) => setTimeout(r, 300));
          }
        }

        send(`\n🎉 Ingestion complete! ${allChunks.length} chunks stored in Supabase.`);
        controller.enqueue(sseEvent({ done: true, ok: true }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send(`❌ Fatal error: ${message}`);
        controller.enqueue(sseEvent({ done: true, ok: false }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

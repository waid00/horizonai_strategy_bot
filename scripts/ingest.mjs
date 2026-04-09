#!/usr/bin/env node
/**
 * Horizon Bank Strategy Bot – Data Ingestion Pipeline
 *
 * Place your documents in /docs and/or /data/uploads in the project root.
 * Supported formats: .pdf, .docx, .txt, .md, .csv
 *
 * Usage:
 *   npm run ingest                     # reads from ./docs and ./data/uploads
 *   npm run ingest -- ./my-folder      # reads from a custom folder only
 */

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import { loadDocumentsFromFolder } from "./load-docs.mjs";
dotenv.config({ path: ".env.local" });


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Chunking ────────────────────────────────────────────────────────────────

function chunkDocument(doc, maxChunkChars = 900) {
  const { content, metadata } = doc;
  const paragraphs = content.split("\n").filter((p) => p.trim().length > 0);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n" + para : para;
    if (candidate.length > maxChunkChars && current.length > 0) {
      chunks.push({ content: current.trim(), metadata });
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push({ content: current.trim(), metadata });
  return chunks;
}

// ─── Embedding Generation ────────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

async function generateEmbeddings(texts) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((item) => item.embedding);
}

// ─── Upsert into Supabase ────────────────────────────────────────────────────

async function upsertChunks(chunks) {
  const { error } = await supabase.from("documents").insert(
    chunks.map((c) => ({
      content: c.content,
      embedding: c.embedding,
      metadata: c.metadata,
    }))
  );
  if (error) throw new Error(`Supabase insert error: ${error.message}`);
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────

async function ingest() {
  const folderPathArg = process.argv[2];
  const folderPaths = folderPathArg
    ? [folderPathArg]
    : ["./docs", "./data/uploads"];

  console.log("🏦  Horizon Bank RAG – Ingestion Pipeline\n");
  console.log(`📂  Reading documents from: ${folderPaths.join(", ")}\n`);

  const missingFolders = folderPaths.filter((folderPath) => !fs.existsSync(folderPath));

  if (folderPathArg && missingFolders.length > 0) {
    console.error(`❌  Folder not found: ${folderPathArg}`);
    process.exit(1);
  }

  const documents = [];
  for (const folderPath of folderPaths) {
    if (!fs.existsSync(folderPath)) {
      console.log(`⚠️  Skipping missing folder: ${folderPath}`);
      continue;
    }

    const loaded = await loadDocumentsFromFolder(folderPath);
    documents.push(...loaded);
  }

  if (documents.length === 0) {
    console.log("⚠️  No documents found. Place .pdf, .docx, .txt, .md, or .csv files in ./docs or ./data/uploads.");
    return;
  }

  console.log(`\n📚  Documents loaded: ${documents.length}`);

  const allChunks = documents.flatMap((doc) => chunkDocument(doc));
  console.log(`📄  Total chunks after splitting: ${allChunks.length}\n`);

  const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(`⚙️   Batch ${batchNum}/${totalBatches} – embedding ${batch.length} chunks...`);

    try {
      const texts = batch.map((c) => c.content);
      const embeddings = await generateEmbeddings(texts);

      const chunksWithEmbeddings = batch.map((chunk, idx) => ({
        ...chunk,
        embedding: embeddings[idx],
      }));

      await upsertChunks(chunksWithEmbeddings);
      console.log(`✅  Batch ${batchNum} upserted.`);
    } catch (err) {
      console.error(`❌  Batch ${batchNum} failed: ${err.message}`);
      throw err;
    }

    if (i + BATCH_SIZE < allChunks.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log("\n🎉  Ingestion complete. Your real documents are now in Supabase.");
  console.log("\n📊  Chunks ingested by domain:");

  const domains = {};
  allChunks.forEach((c) => {
    const d = c.metadata.domain;
    domains[d] = (domains[d] || 0) + 1;
  });
  Object.entries(domains).forEach(([domain, count]) => {
    console.log(`     ${domain}: ${count} chunks`);
  });
}

ingest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

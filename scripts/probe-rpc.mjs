#!/usr/bin/env node
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const url = process.env.SUPABASE_URL;
const openaiKey = process.env.OPENAI_API_KEY;

if (!url || !key || !openaiKey) {
  console.error("Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY");
  process.exit(1);
}

console.log(`[probe] key_prefix=${key.slice(0, 16)}...`);
if (key.startsWith("sb_publishable_")) {
  console.error("[probe] SUPABASE_SERVICE_ROLE_KEY is publishable key, not service_role key.");
  process.exit(1);
}

const supabase = createClient(url, key);
const openai = new OpenAI({ apiKey: openaiKey });

const query = process.argv.slice(2).join(" ") || "NPS target";
console.log(`[probe] query="${query}"`);

// ── 1. Check documents table ──────────────────────────────────────────────
const { count: totalRows } = await supabase
  .from("documents")
  .select("*", { count: "exact", head: true });
console.log(`[probe] documents.total_rows=${totalRows ?? 0}`);

const { count: nullEmbeddings } = await supabase
  .from("documents")
  .select("*", { count: "exact", head: true })
  .is("embedding", null);
console.log(`[probe] documents.null_embeddings=${nullEmbeddings ?? 0}`);

if ((totalRows ?? 0) === 0) {
  console.error("[probe] ❌ documents table is empty – run: npm run ingest");
  process.exit(1);
}
if ((nullEmbeddings ?? 0) > 0) {
  console.warn(`[probe] ⚠ ${nullEmbeddings} rows have NULL embeddings – they are invisible to vector search. Re-run: npm run ingest`);
}

// ── 2. Embed query and test RPC at multiple thresholds ────────────────────
const embedding = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: query,
});

const queryEmbedding = embedding.data[0].embedding;
console.log(`[probe] embedding generated (${queryEmbedding.length}-dim)`);

for (const threshold of [0.5, 0.3, 0.15, 0.0, -1.0]) {
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: 5,
  });

  if (error) {
    console.error(`[probe] ❌ RPC error at threshold=${threshold}:`, error.message);
    console.error("[probe] Ensure you have run supabase/schema.sql in the Supabase SQL Editor.");
    process.exit(1);
  }

  const rows = Array.isArray(data) ? data.length : 0;
  const top = rows > 0 ? data[0] : null;
  console.log(`[probe] threshold=${threshold.toFixed(2)} rows=${rows}${top ? ` top_similarity=${top.similarity?.toFixed(4)} domain=${top.metadata?.domain}` : ""}`);
  if (rows > 0) {
    console.log(`[probe] ✅ Query "${query}" matched ${rows} chunk(s) at threshold=${threshold}`);
    break;
  }
}

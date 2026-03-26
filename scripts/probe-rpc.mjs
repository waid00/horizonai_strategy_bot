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

const embedding = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: query,
});

const queryEmbedding = embedding.data[0].embedding;
const { data, error } = await supabase.rpc("match_documents", {
  query_embedding: queryEmbedding,
  match_threshold: 0.5,
  match_count: 5,
});

if (error) {
  console.error("[probe] RPC error:", error);
  process.exit(1);
}

console.log(`[probe] rows=${(data || []).length}`);
if (Array.isArray(data) && data.length > 0) {
  console.log("[probe] top_similarity=", data[0].similarity);
  console.log("[probe] top_domain=", data[0]?.metadata?.domain);
}

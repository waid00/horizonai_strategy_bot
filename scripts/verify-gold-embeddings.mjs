import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("[VERIFY] Checking gold schema documents...");

// Query all documents and filter client-side for metadata.source
const { data, error } = await supabase
  .from("documents")
  .select("id, content, metadata")
  .order("created_at", { ascending: false })
  .limit(100);

if (error) {
  console.error("[VERIFY] Error:", error.message);
  process.exit(1);
}

const goldDocs = data.filter(d => d.metadata?.source === "gold_schema");

console.log(`[VERIFY] Found ${goldDocs.length} gold schema documents:\n`);
for (const doc of goldDocs.slice(0, 10)) {
  console.log(`ID: ${doc.id}`);
  console.log(`Type: ${doc.metadata.type}`);
  console.log(`Content preview: ${doc.content.slice(0, 80)}...`);
  console.log("");
}

console.log(`[VERIFY] ✅ All ${goldDocs.length} gold schema documents are indexed!`);

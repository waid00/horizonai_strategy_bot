import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("[VERIFY] Checking all documents...");

const { data, error } = await supabase
  .from("documents")
  .select("id, content, metadata")
  .limit(5);

if (error) {
  console.error("[VERIFY] Error:", error.message);
  process.exit(1);
}

console.log(`[VERIFY] Found ${data.length} total documents:\n`);
for (const doc of data) {
  console.log(`ID: ${doc.id}`);
  console.log(`Content preview: ${doc.content.slice(0, 60)}...`);
  console.log(`Metadata:`, JSON.stringify(doc.metadata));
  console.log("");
}

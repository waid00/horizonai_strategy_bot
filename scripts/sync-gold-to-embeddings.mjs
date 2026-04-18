/**
 * Sync Gold Schema to Vector Embeddings
 * 
 * Reads KPI, team, period, and fact data from gold schema tables
 * and stores as embeddings in the documents table for semantic search.
 * 
 * Run: node scripts/sync-gold-to-embeddings.mjs
 */

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const supabaseUrl = process.env.SUPABASE_URL ?? (() => { throw new Error("SUPABASE_URL missing"); })();
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? (() => { throw new Error("SUPABASE_SERVICE_ROLE_KEY missing"); })();
const openaiKey = process.env.OPENAI_API_KEY ?? (() => { throw new Error("OPENAI_API_KEY missing"); })();

const supabase = createClient(supabaseUrl, supabaseKey);
const openai = new OpenAI({ apiKey: openaiKey });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fetch gold schema data
// ─────────────────────────────────────────────────────────────────────────────

async function fetchGoldData() {
  console.log("[SYNC] Fetching gold schema data...");

  const [kpis, teams, periods, facts] = await Promise.all([
    supabase.from("gold_dim_kpi").select("*"),
    supabase.from("gold_dim_team").select("*"),
    supabase.from("gold_dim_period").select("*"),
    supabase.from("gold_fact_kpi").select("*"),
  ]);

  if (kpis.error) throw new Error(`Failed to fetch KPIs: ${kpis.error.message}`);
  if (teams.error) throw new Error(`Failed to fetch teams: ${teams.error.message}`);
  if (periods.error) throw new Error(`Failed to fetch periods: ${periods.error.message}`);
  if (facts.error) throw new Error(`Failed to fetch facts: ${facts.error.message}`);

  console.log(`[SYNC] ✓ Fetched ${kpis.data.length} KPIs, ${teams.data.length} teams, ${periods.data.length} periods, ${facts.data.length} facts`);

  return {
    kpis: kpis.data || [],
    teams: teams.data || [],
    periods: periods.data || [],
    facts: facts.data || [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Format gold data as readable text
// ─────────────────────────────────────────────────────────────────────────────

function formatKPIAsText(kpi) {
  return `
KPI: ${kpi.kpi_name}
Type: ${kpi.kpi_type}
Target: ${kpi.target_value} ${kpi.unit}
Initial: ${kpi.initial_value} ${kpi.unit}
ID: ${kpi.kpi_id}
`.trim();
}

function formatTeamAsText(team) {
  return `
Team: ${team.team_name}
Domain: ${team.domain}
ID: ${team.team_id}
`.trim();
}

function formatPeriodAsText(period) {
  return `
Period: ${period.period}
Quarter: ${period.quarter} ${period.year}
ID: ${period.period_id}
`.trim();
}

function formatFactAsText(fact, kpis, teams, periods) {
  const kpi = kpis.find(k => k.kpi_id === fact.kpi_id);
  const team = teams.find(t => t.team_id === fact.team_id);
  const period = periods.find(p => p.period_id === fact.period_id);

  if (!kpi || !team || !period) return null;

  return `
Performance: ${kpi.kpi_name}
Team: ${team.team_name}
Period: ${period.quarter} ${period.year}
Value: ${fact.value} ${kpi.unit}
Target: ${kpi.target_value} ${kpi.unit}
Gap: ${(kpi.target_value - fact.value).toFixed(1)} ${kpi.unit}
Status: ${fact.value >= kpi.target_value ? "ON TRACK" : "BELOW TARGET"}
Data Quality: ${fact.dq_flag}
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Create document objects with metadata
// ─────────────────────────────────────────────────────────────────────────────

function createDocuments(data) {
  const docs = [];

  // KPI documents
  for (const kpi of data.kpis) {
    docs.push({
      content: formatKPIAsText(kpi),
      metadata: {
        type: "kpi",
        source: "gold_schema",
        kpi_id: kpi.kpi_id,
        kpi_name: kpi.kpi_name,
        kpi_type: kpi.kpi_type,
      },
    });
  }

  // Team documents
  for (const team of data.teams) {
    docs.push({
      content: formatTeamAsText(team),
      metadata: {
        type: "team",
        source: "gold_schema",
        team_id: team.team_id,
        team_name: team.team_name,
        domain: team.domain,
      },
    });
  }

  // Period documents
  for (const period of data.periods) {
    docs.push({
      content: formatPeriodAsText(period),
      metadata: {
        type: "period",
        source: "gold_schema",
        period_id: period.period_id,
        quarter: period.quarter,
        year: period.year,
      },
    });
  }

  // Fact documents (performance data)
  for (const fact of data.facts) {
    const text = formatFactAsText(fact, data.kpis, data.teams, data.periods);
    if (text) {
      docs.push({
        content: text,
        metadata: {
          type: "fact",
          source: "gold_schema",
          kpi_id: fact.kpi_id,
          team_id: fact.team_id,
          period_id: fact.period_id,
        },
      });
    }
  }

  console.log(`[SYNC] ✓ Created ${docs.length} document objects`);
  return docs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Get embeddings from OpenAI
// ─────────────────────────────────────────────────────────────────────────────

async function getEmbeddings(texts) {
  console.log(`[SYNC] Getting embeddings for ${texts.length} texts...`);

  // Batch in groups of 100 per OpenAI limits
  const batches = [];
  for (let i = 0; i < texts.length; i += 100) {
    batches.push(texts.slice(i, i + 100));
  }

  const allEmbeddings = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`[SYNC] Embedding batch ${i + 1}/${batches.length}...`);
    const batch = batches[i];

    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: batch,
    });

    allEmbeddings.push(...response.data.map(e => e.embedding));
  }

  console.log(`[SYNC] ✓ Got ${allEmbeddings.length} embeddings`);
  return allEmbeddings;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Upsert to documents table
// ─────────────────────────────────────────────────────────────────────────────

async function upsertDocuments(docs, embeddings) {
  console.log(`[SYNC] Upserting ${docs.length} documents...`);

  // First, delete old gold schema documents to avoid duplicates
  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("metadata->>'source'", "gold_schema");

  if (deleteError) {
    console.warn(`[SYNC] Warning: Failed to delete old gold documents: ${deleteError.message}`);
  } else {
    console.log(`[SYNC] ✓ Cleared old gold schema documents`);
  }

  // Insert new documents
  const rowsToInsert = docs.map((doc, i) => ({
    content: doc.content,
    embedding: embeddings[i],
    metadata: doc.metadata,
  }));

  const { error, data } = await supabase
    .from("documents")
    .insert(rowsToInsert)
    .select("id");

  if (error) {
    throw new Error(`Failed to upsert documents: ${error.message}`);
  }

  console.log(`[SYNC] ✓ Inserted ${data?.length || 0} documents`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.log("[SYNC] Starting gold schema to embeddings sync...");

    // Fetch gold data
    const goldData = await fetchGoldData();

    // Create document objects
    const docs = createDocuments(goldData);

    // Get embeddings
    const embeddings = await getEmbeddings(docs.map(d => d.content));

    // Upsert to documents table
    await upsertDocuments(docs, embeddings);

    console.log("[SYNC] ✅ Sync complete!");
  } catch (err) {
    console.error("[SYNC] ❌ Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();

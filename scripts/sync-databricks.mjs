#!/usr/bin/env node
/**
 * Horizon Bank – Databricks → Supabase Sync
 *
 * Fetches one or more Databricks tables via the SQL Statement Execution API
 * and upserts the rows into the Supabase `data_records` table.
 *
 * Required env vars (add to .env.local):
 *   DATABRICKS_HOST          e.g. https://adb-1234567890.1.azuredatabricks.net
 *   DATABRICKS_TOKEN         personal access token or service-principal token
 *   DATABRICKS_WAREHOUSE_ID  SQL warehouse ID (find in Databricks SQL → Warehouses)
 *   DATABRICKS_TABLES        comma-separated list of fully-qualified table names,
 *                            e.g. "hive_metastore.default.kpis,catalog.schema.table"
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node scripts/sync-databricks.mjs
 *   node scripts/sync-databricks.mjs hive_metastore.default.kpis
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const DATABRICKS_HOST = process.env.DATABRICKS_HOST?.replace(/\/$/, "");
const DATABRICKS_TOKEN = process.env.DATABRICKS_TOKEN;
const WAREHOUSE_ID = process.env.DATABRICKS_WAREHOUSE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ─── Validation ───────────────────────────────────────────────────────────────

const missing = [
  !DATABRICKS_HOST && "DATABRICKS_HOST",
  !DATABRICKS_TOKEN && "DATABRICKS_TOKEN",
  !WAREHOUSE_ID && "DATABRICKS_WAREHOUSE_ID",
  !SUPABASE_URL && "SUPABASE_URL",
  !SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
].filter(Boolean);

if (missing.length > 0) {
  console.error(`❌  Missing environment variables: ${missing.join(", ")}`);
  console.error("    Add them to .env.local and retry.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Databricks SQL API helpers ───────────────────────────────────────────────

const API_BASE = `${DATABRICKS_HOST}/api/2.0/sql/statements`;
const HEADERS = {
  Authorization: `Bearer ${DATABRICKS_TOKEN}`,
  "Content-Type": "application/json",
};

/**
 * Submit a SQL statement and wait for it to complete (poll until SUCCEEDED).
 * Returns the full response body including the result chunk.
 */
async function executeStatement(sql) {
  // Submit
  const submitRes = await fetch(API_BASE, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      statement: sql,
      warehouse_id: WAREHOUSE_ID,
      wait_timeout: "30s",    // wait up to 30 s synchronously
      on_wait_timeout: "CONTINUE",
    }),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`Databricks submit failed (${submitRes.status}): ${body}`);
  }

  let result = await submitRes.json();

  // Poll until terminal state
  while (result.status?.state === "PENDING" || result.status?.state === "RUNNING") {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${API_BASE}/${result.statement_id}`, {
      headers: HEADERS,
    });
    if (!pollRes.ok) {
      const body = await pollRes.text();
      throw new Error(`Databricks poll failed (${pollRes.status}): ${body}`);
    }
    result = await pollRes.json();
  }

  if (result.status?.state !== "SUCCEEDED") {
    throw new Error(
      `Databricks statement failed: ${JSON.stringify(result.status)}`
    );
  }

  return result;
}

/**
 * Fetch all rows from a Databricks table using cursor-based pagination.
 * Returns an array of plain JS objects (column names as keys).
 */
async function fetchTableRows(tableName) {
  console.log(`  📥  Querying ${tableName} …`);
  const sql = `SELECT * FROM ${tableName}`;

  let result = await executeStatement(sql);
  const columns = result.manifest?.schema?.columns?.map((c) => c.name) ?? [];

  if (columns.length === 0) {
    console.warn(`  ⚠️   No columns returned for ${tableName}`);
    return [];
  }

  const rows = [];

  // Collect first chunk
  const firstChunkData = result.result?.data_array ?? [];
  for (const rawRow of firstChunkData) {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = rawRow[i] ?? null;
    });
    rows.push(obj);
  }

  // Paginate through external links if result is chunked
  const externalLinks = result.result?.external_links ?? [];
  for (const link of externalLinks) {
    const chunkRes = await fetch(link.external_link, { headers: HEADERS });
    if (!chunkRes.ok) continue;
    const chunkData = await chunkRes.json();
    for (const rawRow of chunkData ?? []) {
      const obj = {};
      columns.forEach((col, i) => {
        obj[col] = rawRow[i] ?? null;
      });
      rows.push(obj);
    }
  }

  return rows;
}

// ─── Table Mapping & Upsert ──────────────────────────────────────────────────

const UPSERT_BATCH = 500;

/**
 * Determine which gold table(s) this Databricks table maps to.
 * Returns { type: 'team'|'kpi'|'period'|'fact', data: processedRows }
 * Order matters: check more specific patterns first (fact/metric before kpi).
 */
function mapTableToGold(tableName, rows) {
  const lower = tableName.toLowerCase();

  // Check for fact/metric FIRST (more specific, contains "kpi" in the name)
  if (lower.includes("fact") || lower.includes("metric")) {
    return {
      type: "fact",
      table: "gold_fact_kpi",
      data: rows.map((row) => ({
        period_id: String(row.period_id || "").trim(),
        kpi_id: String(row.kpi_id || "").trim(),
        team_id: String(row.team_id || "").trim(),
        value: parseFloat(row.value ?? 0),
        dq_flag: String(row.dq_flag || row.quality_flag || "").trim(),
      })),
    };
  }

  // Map based on table name patterns
  if (lower.includes("team")) {
    return {
      type: "team",
      table: "gold_dim_team",
      data: rows.map((row) => ({
        team_id: String(row.team_id || row.id || "").trim(),
        team_name: String(row.team_name || row.name || "").trim(),
        domain: String(row.domain || row.dept || "").trim(),
      })),
    };
  }

  if (lower.includes("kpi")) {
    return {
      type: "kpi",
      table: "gold_dim_kpi",
      data: rows.map((row) => ({
        kpi_id: String(row.kpi_id || row.id || "").trim(),
        kpi_name: String(row.kpi_name || row.name || "").trim(),
        kpi_type: String(row.kpi_type || row.type || "").trim(),
        target_value: parseFloat(row.target_value ?? row.target ?? 0),
        initial_value: parseFloat(row.initial_value ?? row.initial ?? 0),
        unit: String(row.unit || "").trim(),
      })),
    };
  }

  if (lower.includes("period")) {
    return {
      type: "period",
      table: "gold_dim_period",
      data: rows.map((row) => ({
        period_id: String(row.period_id || row.id || "").trim(),
        period: String(row.period || "").trim(),
        quarter: String(row.quarter || "Q1").trim(),
        year: parseInt(row.year ?? new Date().getFullYear()),
      })),
    };
  }

  // Default: just store in data_records
  return {
    type: "data_records",
    table: "data_records",
    data: rows,
  };
}

async function upsertRows(tableName, rows) {
  const mapping = mapTableToGold(tableName, rows);

  if (mapping.type === "data_records") {
    // Legacy: Delete existing rows for this table
    const { error: deleteError } = await supabase
      .from("data_records")
      .delete()
      .eq("table_name", tableName);

    if (deleteError) {
      throw new Error(`Supabase delete error for ${tableName}: ${deleteError.message}`);
    }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const batch = rows.slice(i, i + UPSERT_BATCH).map((row) => ({
        table_name: tableName,
        row_data: row,
        synced_at: new Date().toISOString(),
      }));

      const { error } = await supabase.from("data_records").insert(batch);
      if (error) {
        throw new Error(`Supabase insert error: ${error.message}`);
      }
      inserted += batch.length;
    }
    return inserted;
  }

  // Gold tables: upsert (handle duplicates gracefully)
  const goldTable = mapping.table;
  const goldData = mapping.data.filter((row) => {
    // Validate required IDs exist
    if (mapping.type === "fact") {
      return row.period_id && row.kpi_id && row.team_id;
    }
    return row[`${mapping.type}_id`] || row.id;
  });

  if (goldData.length === 0) {
    console.log(`  ⚠️   No valid rows to insert into ${goldTable}`);
    return 0;
  }

  // Determine the correct conflict column(s) for this table
  let conflictColumns = "id"; // default fallback
  if (mapping.type === "team") conflictColumns = "team_id";
  else if (mapping.type === "kpi") conflictColumns = "kpi_id";
  else if (mapping.type === "period") conflictColumns = "period_id";
  else if (mapping.type === "fact") conflictColumns = "period_id,kpi_id,team_id";

  let upserted = 0;
  for (let i = 0; i < goldData.length; i += UPSERT_BATCH) {
    const batch = goldData.slice(i, i + UPSERT_BATCH);

    const { error } = await supabase
      .from(goldTable)
      .upsert(batch, { onConflict: conflictColumns });

    if (error) {
      console.warn(`  ⚠️   Upsert error for ${goldTable}: ${error.message}`);
      throw new Error(`Upsert error for ${goldTable}: ${error.message}`);
    }
    upserted += batch.length;
  }

  return upserted;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const tableArg = process.argv[2];
  const tables = tableArg
    ? [tableArg]
    : (process.env.DATABRICKS_TABLES ?? "").split(",").map((t) => t.trim()).filter(Boolean);

  if (tables.length === 0) {
    console.error("❌  No tables specified.");
    console.error("    Pass a table name as the first argument, or set DATABRICKS_TABLES in .env.local.");
    process.exit(1);
  }

  console.log("🏦  Horizon Bank – Databricks → Supabase Sync\n");
  console.log(`📋  Tables to sync: ${tables.join(", ")}\n`);

  let totalRows = 0;
  const results = [];

  for (const tableName of tables) {
    try {
      const rows = await fetchTableRows(tableName);
      console.log(`  ✅  Fetched ${rows.length} rows from ${tableName}`);

      if (rows.length === 0) {
        console.log(`  ⚠️   Skipping upsert – no rows returned.`);
        continue;
      }

      const upserted = await upsertRows(tableName, rows);
      const mapping = mapTableToGold(tableName, rows);
      const targetTable = mapping.type === "data_records" ? "data_records" : `${mapping.table} (${mapping.type})`;
      
      console.log(`  💾  Upserted ${upserted} rows into ${targetTable}\n`);
      results.push({
        table: tableName,
        type: mapping.type,
        goldTable: mapping.table,
        rowsUpserted: upserted,
      });
      totalRows += upserted;
    } catch (err) {
      console.error(`  ❌  Failed to sync ${tableName}: ${err.message}`);
    }
  }

  console.log("\n📊  Sync Summary:");
  for (const r of results) {
    const icon = r.type === "data_records" ? "📦" : "✨";
    console.log(`  ${icon} ${r.table} → ${r.goldTable} (${r.rowsUpserted} rows)`);
  }

  console.log(`\n🎉  Sync complete. Total rows upserted: ${totalRows}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

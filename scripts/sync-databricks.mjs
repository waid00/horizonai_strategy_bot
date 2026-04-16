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

// ─── Supabase upsert ──────────────────────────────────────────────────────────

const UPSERT_BATCH = 500;

async function upsertRows(tableName, rows) {
  // Delete existing rows for this table so we get a clean full refresh.
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

  for (const tableName of tables) {
    try {
      const rows = await fetchTableRows(tableName);
      console.log(`  ✅  Fetched ${rows.length} rows from ${tableName}`);

      if (rows.length === 0) {
        console.log(`  ⚠️   Skipping upsert – no rows returned.`);
        continue;
      }

      const inserted = await upsertRows(tableName, rows);
      console.log(`  💾  Upserted ${inserted} rows into data_records for table "${tableName}"\n`);
      totalRows += inserted;
    } catch (err) {
      console.error(`  ❌  Failed to sync ${tableName}: ${err.message}`);
    }
  }

  console.log(`🎉  Sync complete. Total rows upserted: ${totalRows}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

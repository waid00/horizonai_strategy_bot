/**
 * Horizon Bank – Databricks Sync API Route
 * POST /api/sync-databricks
 *
 * Triggers the Databricks → Supabase sync from the browser or a cron job.
 * Requires the same env vars as scripts/sync-databricks.mjs.
 *
 * Body (optional JSON):
 *   { "tables": ["hive_metastore.default.kpis"] }
 *   If omitted, falls back to DATABRICKS_TABLES env var.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// ─── Env helpers ──────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// ─── Databricks API ───────────────────────────────────────────────────────────

interface DatabricksColumn {
  name: string;
}

interface DatabricksResult {
  statement_id: string;
  status: { state: string };
  manifest?: { schema?: { columns?: DatabricksColumn[] } };
  result?: {
    data_array?: (string | null)[][];
    external_links?: Array<{ external_link: string }>;
  };
}

async function executeStatement(
  host: string,
  token: string,
  warehouseId: string,
  sql: string
): Promise<DatabricksResult> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const apiBase = `${host}/api/2.0/sql/statements`;

  const submitRes = await fetch(apiBase, {
    method: "POST",
    headers,
    body: JSON.stringify({
      statement: sql,
      warehouse_id: warehouseId,
      wait_timeout: "30s",
      on_wait_timeout: "CONTINUE",
    }),
  });

  if (!submitRes.ok) {
    const text = await submitRes.text();
    throw new Error(`Databricks submit failed (${submitRes.status}): ${text}`);
  }

  let result: DatabricksResult = await submitRes.json();

  while (
    result.status?.state === "PENDING" ||
    result.status?.state === "RUNNING"
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${apiBase}/${result.statement_id}`, { headers });
    if (!pollRes.ok) {
      const text = await pollRes.text();
      throw new Error(`Databricks poll failed (${pollRes.status}): ${text}`);
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

async function fetchTableRows(
  host: string,
  token: string,
  warehouseId: string,
  tableName: string
): Promise<Record<string, unknown>[]> {
  const result = await executeStatement(
    host,
    token,
    warehouseId,
    `SELECT * FROM ${tableName}`
  );

  const columns =
    result.manifest?.schema?.columns?.map((c: DatabricksColumn) => c.name) ?? [];

  if (columns.length === 0) return [];

  const rows: Record<string, unknown>[] = [];
  const apiHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // First inline chunk
  for (const rawRow of result.result?.data_array ?? []) {
    const obj: Record<string, unknown> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = rawRow[i] ?? null;
    });
    rows.push(obj);
  }

  // Paginated external links
  for (const link of result.result?.external_links ?? []) {
    const res = await fetch(link.external_link, { headers: apiHeaders });
    if (!res.ok) continue;
    const chunkData: (string | null)[][] = await res.json();
    for (const rawRow of chunkData ?? []) {
      const obj: Record<string, unknown> = {};
      columns.forEach((col: string, i: number) => {
        obj[col] = rawRow[i] ?? null;
      });
      rows.push(obj);
    }
  }

  return rows;
}

// ─── Supabase upsert ──────────────────────────────────────────────────────────

const BATCH_SIZE = 500;

/**
 * Map Databricks table to gold schema table based on naming patterns.
 * Order matters: check more specific patterns first (fact/metric before kpi).
 */
function mapTableToGold(tableName: string, rows: Record<string, unknown>[]) {
  const lower = tableName.toLowerCase();
  console.log(`[Sync] Attempting to map table: "${tableName}" (lower: "${lower}")`);

  // Check for fact/metric FIRST (more specific, contains "kpi" in the name)
  if (lower.includes("fact") || lower.includes("metric")) {
    console.log(`[Sync] ✓ Matched "fact/metric" pattern → gold_fact_kpi`);
    return {
      type: "fact",
      table: "gold_fact_kpi",
      data: rows.map((row) => ({
        period_id: String(row.period_id || "").trim(),
        kpi_id: String(row.kpi_id || "").trim(),
        team_id: String(row.team_id || "").trim(),
        value: parseFloat(String(row.value ?? 0)),
        dq_flag: String(row.dq_flag || row.quality_flag || "").trim(),
      })),
    };
  }

  if (lower.includes("team")) {
    console.log(`[Sync] ✓ Matched "team" pattern → gold_dim_team`);
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
    console.log(`[Sync] ✓ Matched "kpi" pattern → gold_dim_kpi`);
    return {
      type: "kpi",
      table: "gold_dim_kpi",
      data: rows.map((row) => ({
        kpi_id: String(row.kpi_id || row.id || "").trim(),
        kpi_name: String(row.kpi_name || row.name || "").trim(),
        kpi_type: String(row.kpi_type || row.type || "").trim(),
        target_value: parseFloat(String(row.target_value ?? row.target ?? 0)),
        initial_value: parseFloat(String(row.initial_value ?? row.initial ?? 0)),
        unit: String(row.unit || "").trim(),
      })),
    };
  }

  if (lower.includes("period")) {
    console.log(`[Sync] ✓ Matched "period" pattern → gold_dim_period`);
    return {
      type: "period",
      table: "gold_dim_period",
      data: rows.map((row) => ({
        period_id: String(row.period_id || row.id || "").trim(),
        period: String(row.period || "").trim(),
        quarter: String(row.quarter || "Q1").trim(),
        year: parseInt(String(row.year ?? new Date().getFullYear())),
      })),
    };
  }

  console.log(`[Sync] ✗ No pattern matched → falling back to data_records`);
  // Default: data_records
  return {
    type: "data_records",
    table: "data_records",
    data: rows,
  };
}

async function syncTableToSupabase(
  supabase: SupabaseClient,
  tableName: string,
  rows: Record<string, unknown>[]
): Promise<{ goldTable: string; type: string; rowsUpserted: number }> {
  const mapping = mapTableToGold(tableName, rows);

  if (mapping.type === "data_records") {
    // Legacy: delete and re-insert into data_records
    const { error: deleteError } = await supabase
      .from("data_records")
      .delete()
      .eq("table_name", tableName);

    if (deleteError) {
      throw new Error(
        `Supabase delete error for ${tableName}: ${deleteError.message}`
      );
    }

    let inserted = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE).map((row) => ({
        table_name: tableName,
        row_data: row,
        synced_at: now,
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await supabase.from("data_records").insert(batch as any);
      if (error) throw new Error(`Supabase insert error: ${error.message}`);
      inserted += batch.length;
    }

    return {
      goldTable: "data_records",
      type: "data_records",
      rowsUpserted: inserted,
    };
  }

  // Gold tables: upsert
  const goldTable = mapping.table;
  const goldData = mapping.data.filter((row) => {
    if (mapping.type === "fact") {
      const fr = row as Record<string, unknown>;
      const valid = !!(fr.period_id && fr.kpi_id && fr.team_id);
      if (!valid) {
        console.log(`[Sync] Filtering fact row: missing keys. period_id=${fr.period_id}, kpi_id=${fr.kpi_id}, team_id=${fr.team_id}`);
      }
      return valid;
    }
    const r = row as Record<string, unknown>;
    const valid = !!(r[`${mapping.type}_id`] || r.id);
    if (!valid) {
      console.log(`[Sync] Filtering ${mapping.type} row: missing ${mapping.type}_id or id`);
    }
    return valid;
  });

  console.log(`[Sync] After validation: ${goldData.length}/${mapping.data.length} rows pass for ${goldTable}`);

  if (goldData.length === 0) {
    console.log(`[Sync] ⚠️  No valid rows to insert into ${goldTable}`);
    return { goldTable, type: mapping.type, rowsUpserted: 0 };
  }

  // Determine the correct conflict column(s) for this table
  let conflictColumns = "id"; // default fallback
  if (mapping.type === "team") conflictColumns = "team_id";
  else if (mapping.type === "kpi") conflictColumns = "kpi_id";
  else if (mapping.type === "period") conflictColumns = "period_id";
  else if (mapping.type === "fact") conflictColumns = "period_id,kpi_id,team_id";

  console.log(`[Sync] Upserting into ${goldTable} with onConflict: "${conflictColumns}"`);

  let upserted = 0;
  for (let i = 0; i < goldData.length; i += BATCH_SIZE) {
    const batch = goldData.slice(i, i + BATCH_SIZE);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await supabase
      .from(goldTable)
      .upsert(batch as any, {
        onConflict: conflictColumns,
      });

    if (error) {
      console.error(`[Sync] ❌ Upsert error for ${goldTable}: ${error.message}`);
      throw new Error(`Upsert error for ${goldTable}: ${error.message}`);
    }
    upserted += batch.length;
    console.log(`[Sync] Upserted batch: ${batch.length} rows (total: ${upserted})`);
  }

  console.log(`[Sync] ✅ Successfully upserted ${upserted} rows into ${goldTable}`);
  return { goldTable, type: mapping.type, rowsUpserted: upserted };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const databricksHost = requireEnv("DATABRICKS_HOST").replace(/\/$/, "");
    const databricksToken = requireEnv("DATABRICKS_TOKEN");
    const warehouseId = requireEnv("DATABRICKS_WAREHOUSE_ID");

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    // Determine which tables to sync
    let tables: string[] = [];
    try {
      const body = await req.json() as { tables?: string[] };
      if (Array.isArray(body.tables) && body.tables.length > 0) {
        tables = body.tables;
      }
    } catch {
      // body is optional
    }

    if (tables.length === 0) {
      const envTables = process.env.DATABRICKS_TABLES ?? "";
      tables = envTables
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }

    if (tables.length === 0) {
      return NextResponse.json(
        {
          error:
            "No tables specified. Pass { tables: [...] } in the request body or set DATABRICKS_TABLES in .env.local.",
        },
        { status: 400 }
      );
    }

    const results: Array<{
      table: string;
      goldTable?: string;
      type?: string;
      rows?: number;
      error?: string;
    }> = [];

    for (const tableName of tables) {
      try {
        const rows = await fetchTableRows(
          databricksHost,
          databricksToken,
          warehouseId,
          tableName
        );
        console.log(`[Sync] Fetched ${rows.length} rows from "${tableName}"`);
        
        if (rows.length === 0) {
          console.log(`[Sync] Skipping "${tableName}" – no rows`);
          results.push({ table: tableName, rows: 0 });
          continue;
        }

        const syncResult = await syncTableToSupabase(supabase, tableName, rows);
        console.log(`[Sync] ✅ Synced "${tableName}" → ${syncResult.goldTable} (type: ${syncResult.type}, rows: ${syncResult.rowsUpserted})`);
        results.push({
          table: tableName,
          goldTable: syncResult.goldTable,
          type: syncResult.type,
          rows: syncResult.rowsUpserted,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Sync] ❌ Failed to sync "${tableName}": ${message}`);
        results.push({ table: tableName, error: message });
      }
    }

    console.log(`[Sync] Results:`, JSON.stringify(results, null, 2));

    const hasErrors = results.some((r) => r.error !== undefined);
    return NextResponse.json(
      { ok: !hasErrors, results },
      { status: hasErrors ? 207 : 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

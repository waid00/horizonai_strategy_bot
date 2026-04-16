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

async function syncTableToSupabase(
  supabase: SupabaseClient,
  tableName: string,
  rows: Record<string, unknown>[]
): Promise<number> {
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

  return inserted;
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
        const inserted = rows.length > 0
          ? await syncTableToSupabase(supabase, tableName, rows)
          : 0;
        results.push({ table: tableName, rows: inserted });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ table: tableName, error: message });
      }
    }

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

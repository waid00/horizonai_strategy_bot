/**
 * Horizon Bank – Schema Endpoint
 * GET /api/schema
 *
 * Returns a description of the columns in the `data_records` table so the
 * LLM knows what JSONB keys exist inside `row_data` for each Databricks table.
 *
 * Response shape:
 * {
 *   tables: [
 *     {
 *       table_name: "hive_metastore.default.kpis",
 *       row_count: 42,
 *       columns: ["kpi_name", "current_value", "target_value", ...]
 *     }
 *   ]
 * }
 */

import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
      { status: 500 }
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // Fetch one sample row per distinct table_name to discover JSONB keys
    const { data: tableNames, error: tnError } = await supabase
      .from("data_records")
      .select("table_name")
      .limit(1000);

    if (tnError) {
      return NextResponse.json(
        { error: `Failed to query data_records: ${tnError.message}` },
        { status: 500 }
      );
    }

    // Unique table names
    const uniqueTables = [...new Set((tableNames ?? []).map((r) => r.table_name as string))];

    const tables: Array<{
      table_name: string;
      row_count: number;
      columns: string[];
    }> = [];

    for (const tableName of uniqueTables) {
      // Count rows
      const { count } = await supabase
        .from("data_records")
        .select("*", { count: "exact", head: true })
        .eq("table_name", tableName);

      // Get a sample row to infer column names
      const { data: sampleRows } = await supabase
        .from("data_records")
        .select("row_data")
        .eq("table_name", tableName)
        .limit(1);

      const columns =
        sampleRows && sampleRows.length > 0
          ? Object.keys(sampleRows[0].row_data as Record<string, unknown>)
          : [];

      tables.push({
        table_name: tableName,
        row_count: count ?? 0,
        columns,
      });
    }

    return NextResponse.json({ tables });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

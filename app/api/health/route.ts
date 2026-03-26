/**
 * Horizon Bank Strategy Bot – Health Check Endpoint
 * File: /app/api/health/route.ts
 *
 * GET /api/health
 * Returns a JSON diagnostic report covering:
 *   - Environment variables (set / missing)
 *   - Supabase connectivity + documents row count
 *   - match_documents RPC function availability
 *
 * Use this endpoint to diagnose "chunks=0" issues when the documents
 * table has data but the chat returns "Insufficient data".
 */

import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "edge";

interface CheckResult {
  ok: boolean;
  [key: string]: unknown;
}

export async function GET() {
  const report: Record<string, CheckResult> = {};
  let overallOk = true;

  // ── 1. Environment variables ──────────────────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const openaiKey = process.env.OPENAI_API_KEY ?? "";

  let keyDescription: string;
  if (!serviceRoleKey) {
    keyDescription = "MISSING";
  } else if (serviceRoleKey.startsWith("sb_publishable_")) {
    keyDescription =
      "publishable key – WRONG (use the service_role secret from Supabase Dashboard → Settings → API)";
  } else {
    keyDescription = "service_role ✓";
  }

  report.env = {
    ok: !!supabaseUrl && !!serviceRoleKey && !!openaiKey && !serviceRoleKey.startsWith("sb_publishable_"),
    supabase_url: supabaseUrl ? "set ✓" : "MISSING – add SUPABASE_URL to .env.local",
    supabase_key: keyDescription,
    openai_key: openaiKey ? "set ✓" : "MISSING – add OPENAI_API_KEY to .env.local",
  };
  if (!report.env.ok) overallOk = false;

  // ── 2. Supabase: documents table row count ────────────────────────────────
  if (supabaseUrl && serviceRoleKey) {
    try {
      const supabase = createClient(supabaseUrl, serviceRoleKey);
      const { count, error } = await supabase
        .from("documents")
        .select("*", { count: "exact", head: true });

      if (error) {
        report.documents_table = {
          ok: false,
          error: error.message,
          hint: "The documents table may not exist. Run supabase/schema.sql in the Supabase SQL Editor.",
        };
        overallOk = false;
      } else {
        const rows = count ?? 0;
        report.documents_table = {
          ok: rows > 0,
          rows,
          hint: rows === 0
            ? "Table exists but is empty – run: npm run ingest"
            : undefined,
        };
        if (rows === 0) overallOk = false;
      }
    } catch (err) {
      report.documents_table = { ok: false, error: String(err) };
      overallOk = false;
    }
  } else {
    report.documents_table = { ok: false, error: "Skipped – missing env vars" };
    overallOk = false;
  }

  // ── 3. Supabase: match_documents RPC function ─────────────────────────────
  if (supabaseUrl && serviceRoleKey) {
    try {
      const supabase = createClient(supabaseUrl, serviceRoleKey);

      // A unit vector along the first dimension – valid for cosine similarity.
      const testVector = new Array(1536).fill(0);
      testVector[0] = 1;

      const { error } = await supabase.rpc("match_documents", {
        query_embedding: testVector,
        match_threshold: 0.0,
        match_count: 1,
      });

      if (error) {
        const isMissing =
          error.message.toLowerCase().includes("function") ||
          error.message.toLowerCase().includes("does not exist") ||
          error.code === "PGRST202";

        report.rpc_match_documents = {
          ok: false,
          error: error.message,
          hint: isMissing
            ? "The match_documents function does not exist. Open the Supabase SQL Editor and run the contents of supabase/schema.sql."
            : "Unexpected RPC error – check Supabase logs for details.",
        };
        overallOk = false;
      } else {
        report.rpc_match_documents = { ok: true };
      }
    } catch (err) {
      report.rpc_match_documents = { ok: false, error: String(err) };
      overallOk = false;
    }
  } else {
    report.rpc_match_documents = { ok: false, error: "Skipped – missing env vars" };
    overallOk = false;
  }

  return NextResponse.json(
    { status: overallOk ? "ok" : "degraded", checks: report },
    { status: 200 }
  );
}

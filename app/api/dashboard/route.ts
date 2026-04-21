/**
 * Horizon Bank – Semantic Dashboard Interpreter Route
 * POST /api/dashboard
 *
 * Receives a dashboard image and optional user query, then:
 * 1. Analyzes the image using Claude Vision
 * 2. Maps visual elements to the database schema
 * 3. Generates DuckDB-compatible SQL queries
 * 4. Executes queries against CSV files
 * 5. Returns verification results and insights
 *
 * Request body (multipart/form-data):
 * {
 *   image: File (PNG),
 *   query?: string (optional user question)
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   analysis: string (LLM analysis text),
 *   reasoning: { extraction, mapping, query_generation, analysis },
 *   sqlQuery: string,
 *   execution: { success, data, row_count, error },
 *   explanation: { status, message, data_summary }
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { initDuckDB, getDimensionValues } from "../../../lib/duckdb-connector.js";
import {
  analyzeDashboardImage,
  executeSemanticQuery,
  generateExplanation,
} from "../../../lib/semantic-interpreter.js";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    // Parse multipart form data
    const formData = await req.formData();
    const imageFile = formData.get("image") as File;
    const userQuery = (formData.get("query") as string) || undefined;

    if (!imageFile) {
      return NextResponse.json({ error: "No image file provided" }, { status: 400 });
    }

    if (!imageFile.type.includes("image")) {
      return NextResponse.json({ error: "File must be an image" }, { status: 400 });
    }

    // Convert image to buffer
    const imageBuffer = Buffer.from(await imageFile.arrayBuffer());

    // Initialize in-memory tables from CSVs
    console.log("Loading CSV tables...");
    const tables = initDuckDB();
    console.log("Tables loaded:", Object.keys(tables));

    // Analyze dashboard image
    console.log("Analyzing dashboard image...");
    const analysis = await analyzeDashboardImage(imageBuffer, userQuery, tables);

    // Execute semantic query
    let execution: { success: boolean; error: string | null; data: any[] | null; row_count?: number } = { success: false, error: "No SQL generated", data: null };
    if (analysis.sqlQuery) {
      console.log("Executing query:", analysis.sqlQuery);
      execution = await executeSemanticQuery(tables, analysis.sqlQuery);
    }

    // Generate explanation
    const result = {
      success: execution.success,
      analysis: analysis.analysis,
      reasoning: analysis.reasoning,
      sqlQuery: analysis.sqlQuery,
      execution: {
        success: execution.success,
        data: execution.data,
        row_count: execution.row_count || 0,
        error: execution.error,
      },
    };

    const explanation = generateExplanation(result, userQuery);

    return NextResponse.json(
      {
        ...result,
        explanation,
      },
      { status: execution.success ? 200 : 400 }
    );
  } catch (error) {
    console.error("Dashboard interpretation error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}

/**
 * GET handler for health check and metadata
 */
export async function GET(req: NextRequest) {
  try {
    const tables = initDuckDB();
    const dims = getDimensionValues(tables);

    return NextResponse.json({
      status: "ready",
      tables_loaded: Object.keys(tables),
      dimension_values: {
        types: dims.types || [],
        segments: dims.segments || [],
        categories: dims.categories || [],
        item_count: (dims.items || []).length,
        months: dims.months || [],
        quarters: dims.quarters || [],
      },
    });
  } catch (error) {
    console.error("Dashboard metadata error:", error);
    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Failed to load metadata",
      },
      { status: 500 }
    );
  }
}

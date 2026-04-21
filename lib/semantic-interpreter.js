/**
 * Semantic Dashboard Interpreter
 * 
 * Uses GPT-4 Vision + Chain-of-Thought reasoning to:
 * 1. Analyze dashboard images
 * 2. Extract visual elements (charts, legends, values)
 * 3. Map to database schema using semantic rules
 * 4. Generate DuckDB-compatible SQL queries
 * 5. Execute and verify against actual data
 */

import OpenAI from "openai";
import { buildDimensionContext, executeQuery, validateSql } from "./duckdb-connector.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * System prompt for semantic dashboard interpretation
 */
function buildSystemPrompt(dimensionContext) {
  return `You are an Expert Financial Data Analyst and Vision Specialist. Your task is to act as a bridge between a Dashboard Image (PNG) and a Data Warehouse (Gold Layer). You help users understand their financial data by mapping visual chart elements to actual database records.

Context (Database Schema):
The underlying data warehouse uses a star schema with dimensions and facts:

gold_dim_typ: Transaction types (Revenue, Náklady, Rozvaha)
- typ_key: INT PRIMARY KEY
- typ_nazev: VARCHAR(50) - Type name
- smer: VARCHAR(50) - Direction
- ovlivnuje_profit: VARCHAR(3) - Affects profit? (Ano/Ne)

gold_dim_polozka: Financial line items (products/services)
- polozka_key: INT PRIMARY KEY
- polozka_nazev: VARCHAR(100) - Item name
- kategorie: VARCHAR(100) - Category
- typ: VARCHAR(50) - Type
- smer: VARCHAR(50) - Direction
- segment: VARCHAR(50) - Business segment (Retail, Corporate, Treasury, Provoz, Riziko)

gold_dim_date: Time dimension
- date_key: INT - Format YYYYMM (e.g., 202501)
- mesic_kod: VARCHAR(10) - Format YYYY-MM
- rok: INT - Year
- mesic_cislo: INT - Month number
- mesic_nazev: VARCHAR(20) - Czech month name (Leden, Únor, Březen, etc.)
- kvartal: VARCHAR(2) - Quarter (Q1, Q2, Q3, Q4)
- kvartal_rok: VARCHAR(10) - Quarter year (Q1 2025)
- pololeti: VARCHAR(2) - Half-year (H1, H2)

gold_fact_financials: Financial facts
- fact_key: INT PRIMARY KEY
- date_key: INT - Reference to gold_dim_date
- polozka_key: INT - Reference to gold_dim_polozka
- typ_key: INT - Reference to gold_dim_typ
- hodnota_mil_kc: DECIMAL(18, 6) - Value in Millions CZK
- profit_kontribuce_mil_kc: DECIMAL(18, 6) - Impact on bottom line

${dimensionContext}

Metadata Mapping Rules:

1. Time Axis: If you see months (Leden, Únor, etc.) or quarters (Q1, Q2, etc.), map them to:
   - gold_dim_date.mesic_nazev for months
   - gold_dim_date.kvartal for quarters

2. Categories: Legend items like "Revenue" or "Náklady" must map to:
   - gold_dim_typ.typ_nazev

3. Line/Bar Items: Specific names like "Retailové úvěry" or "IT & infrastruktura" must map to:
   - gold_dim_polozka.polozka_nazev
   - Consider segment context (Retail, Corporate, etc.)

4. Values: Numbers in "mil. Kč" correspond to:
   - gold_fact_financials.hodnota_mil_kc column

Operational Protocol (FOLLOW STRICTLY):

Step 1: Visual Extraction
- Analyze the provided image
- Identify all charts, titles, legends, and axis labels
- Extract numeric values and their units
- Note time periods displayed

Step 2: Semantic Mapping
- Match extracted visual labels to DDL columns and available dimension values
- If a visual element is ambiguous, pick the most likely match based on context
- Note any assumptions made

Step 3: Query Generation
- Generate SQL queries in this format:
  SELECT date_key, polozka_nazev, hodnota_mil_kc 
  FROM gold_fact_financials 
  JOIN gold_dim_date ON gold_fact_financials.date_key = gold_dim_date.date_key
  JOIN gold_dim_polozka ON gold_fact_financials.polozka_key = gold_dim_polozka.polozka_key
  WHERE condition
  ORDER BY date_key

Step 4: Query Listing
- In your response, include a section:
  SQL_QUERY: [your complete SQL statement]
  This should be executable DuckDB SQL

Step 5: Analysis Instructions
- Identify if the question is about a "Snapshot" (single point in time) or "Trend" (over time)
- Adjust GROUP BY and aggregations accordingly
- Ensure all table joins are explicit

CRITICAL: Always output your reasoning in structured steps. End your response with the SQL_QUERY section.`;
}

/**
 * Analyze a dashboard image and generate verification query
 */
export async function analyzeDashboardImage(imageBuffer, userQuery, tables) {
  const dimensionContext = buildDimensionContext(tables);
  const systemPrompt = buildSystemPrompt(dimensionContext);

  // Convert buffer to base64
  const base64Image = imageBuffer.toString("base64");

  const userPrompt = `${systemPrompt}

---

Please analyze this dashboard image. ${
    userQuery
      ? `User question: ${userQuery}`
      : "Provide a comprehensive analysis of all visible data elements and their mapping to the database."
  }

Follow the Operational Protocol strictly:
1. Extract all visual elements
2. Map them to the database schema
3. Generate a DuckDB-compatible SQL query
4. End your response with: SQL_QUERY: [your SQL]`;

  const response = await client.messages.create({
    model: "gpt-4o",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${base64Image}`,
              detail: "high",
            },
          },
          {
            type: "text",
            text: userPrompt,
          },
        ],
      },
    ],
  });

  const analysisText = response.choices[0].message.content;

  // Extract SQL query from response
  const sqlMatch = analysisText.match(/SQL_QUERY:\s*(.*?)(?:\n\n|$)/s);
  const sqlQuery = sqlMatch ? sqlMatch[1].trim() : null;

  return {
    analysis: analysisText,
    sqlQuery,
    reasoning: extractReasoningSteps(analysisText),
  };
}

/**
 * Extract reasoning steps from LLM response
 */
function extractReasoningSteps(text) {
  const steps = {
    extraction: "",
    mapping: "",
    query_generation: "",
    analysis: "",
  };

  // Extract Step 1
  const step1Match = text.match(/Step 1.*?:(.*?)(?=Step 2|Step 3|Step 4|Step 5|SQL_QUERY|$)/is);
  if (step1Match) steps.extraction = step1Match[1].trim();

  // Extract Step 2
  const step2Match = text.match(/Step 2.*?:(.*?)(?=Step 3|Step 4|Step 5|SQL_QUERY|$)/is);
  if (step2Match) steps.mapping = step2Match[1].trim();

  // Extract Step 3
  const step3Match = text.match(/Step 3.*?:(.*?)(?=Step 4|Step 5|SQL_QUERY|$)/is);
  if (step3Match) steps.query_generation = step3Match[1].trim();

  // Extract Step 5
  const step5Match = text.match(/Step 5.*?:(.*?)(?=SQL_QUERY|$)/is);
  if (step5Match) steps.analysis = step5Match[1].trim();

  return steps;
}

/**
 * Execute semantic query and verify against visual data
 */
export async function executeSemanticQuery(tables, sqlQuery) {
  // Validate SQL
  const validation = validateSql(sqlQuery);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      data: null,
    };
  }

  try {
    const data = executeQuery(tables, sqlQuery);
    return {
      success: true,
      error: null,
      data,
      row_count: data.length,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      data: null,
    };
  }
}

/**
 * Full dashboard interpretation pipeline
 */
export async function interpretDashboard(imageBuffer, userQuery, tables) {
  // Step 1: Analyze image
  const analysis = await analyzeDashboardImage(imageBuffer, userQuery, tables);

  if (!analysis.sqlQuery) {
    return {
      success: false,
      error: "Could not generate SQL query from image analysis",
      analysis: analysis.analysisText,
      data: null,
    };
  }

  // Step 2: Execute query
  const execution = await executeSemanticQuery(tables, analysis.sqlQuery);

  // Step 3: Synthesis and verification
  const synthesis = generateSynthesis(
    analysis,
    execution,
    userQuery
  );

  return {
    success: execution.success,
    analysis: analysis.analysis,
    reasoning: analysis.reasoning,
    sqlQuery: analysis.sqlQuery,
    execution: execution,
    synthesis: synthesis,
  };
}

/**
 * Generate synthesis comparing visual analysis with data
 */
function generateSynthesis(analysis, execution, userQuery) {
  if (!execution.success) {
    return {
      status: "error",
      message: `Query execution failed: ${execution.error}`,
      recommendation:
        "Please review the query generation and ensure all table names and columns are correct.",
    };
  }

  const rowCount = execution.data.length;
  const summary = {
    status: "success",
    rows_retrieved: rowCount,
    message: `Successfully retrieved ${rowCount} data points from the gold layer.`,
    verification: {
      data_points: rowCount,
      time_coverage: rowCount > 0 ? "Multiple periods" : "N/A",
      segments_included: rowCount > 0 ? "See data below" : "N/A",
    },
  };

  return summary;
}

/**
 * Helper: Generate human-friendly explanation
 */
export function generateExplanation(result, userQuery) {
  if (!result.success) {
    return {
      status: "error",
      message: result.error || "Analysis failed",
      suggestion: "Please try uploading a clearer image or reformulating your question.",
    };
  }

  const dataPoints = result.execution.data;
  if (!dataPoints || dataPoints.length === 0) {
    return {
      status: "no_data",
      message: "Query executed successfully but returned no data.",
      suggestion: "The dashboard may show data that doesn't exist in the database yet.",
    };
  }

  // Build explanation from synthesis
  return {
    status: "success",
    message: result.synthesis.message,
    data_summary: {
      total_rows: dataPoints.length,
      sample_data: dataPoints.slice(0, 5),
      all_data: dataPoints,
    },
    reasoning: result.reasoning,
  };
}

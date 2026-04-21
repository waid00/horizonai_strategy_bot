# Horizon Bank Dashboard Backend - Semantic Interpreter

## Overview

A production-ready backend for analyzing financial dashboards using GPT-4 Vision AI and semantic database mapping. The system bridges visual chart elements to a star-schema database, enabling LLM-powered financial data insights.

## Architecture

### Components

1. **CSV Connector** (`lib/duckdb-connector.js`)
   - Loads CSV files into in-memory tables
   - Provides simple SQL query execution
   - Validates queries for security
   - Extracts dimension values for semantic mapping

2. **Semantic Interpreter** (`lib/semantic-interpreter.js`)
   - Analyzes dashboard images with GPT-4 Vision
   - Maps visual elements to database schema using chain-of-thought reasoning
   - Generates DuckDB-compatible SQL queries
   - Executes queries and returns verification results

3. **API Route** (`app/api/dashboard/route.ts`)
   - POST `/api/dashboard` - Analyze dashboard image with optional query
   - GET `/api/dashboard` - Health check and metadata

## Data Model

### Gold Star Schema

**Dimensions:**
- `gold_dim_typ`: Transaction types (Revenue, Náklady, Rozvaha)
- `gold_dim_polozka`: Financial line items (products/services)
- `gold_dim_date`: Time dimension (months, quarters, years)

**Facts:**
- `gold_fact_financials`: Financial metrics (values, profit contribution)

### Available Segments
- Retail, Corporate, Treasury, Ostatní (Other), Provoz (Operations), Riziko (Risk), Daň (Tax), Tým (Team), Kapitál (Capital)

### Available Categories
- Úrokové výnosy (Interest Income)
- Poplatky & provize (Fees & Commissions)
- Ostatní výnosy (Other Income)
- Provozní náklady (Operating Costs)
- Náklady na riziko (Risk Costs)
- Daň z příjmů (Income Tax)
- Týmové náklady (Team Costs)
- Vlastní kapitál (Equity)

## Usage

### Setup

1. **Configure API Key**
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

2. **Start Development Server**
   ```bash
   npm run dev
   ```

3. **Test the Backend**
   ```bash
   node scripts/test-semantic-dashboard.mjs
   ```

### API Endpoints

#### POST /api/dashboard
Analyze a dashboard image and map it to database records.

**Request:**
```bash
curl -F "image=@dashboard.png" \
     -F "query=What are the Q1 revenue trends?" \
     http://localhost:3000/api/dashboard
```

**Request Body (multipart/form-data):**
- `image` (File, required) - PNG screenshot of dashboard
- `query` (string, optional) - User question about the dashboard

**Response:**
```json
{
  "success": true,
  "analysis": "LLM chain-of-thought analysis...",
  "reasoning": {
    "extraction": "Visual elements found...",
    "mapping": "Mapped to schema...",
    "query_generation": "SQL generated...",
    "analysis": "Insights..."
  },
  "sqlQuery": "SELECT ... FROM gold_fact_financials ...",
  "execution": {
    "success": true,
    "data": [...rows...],
    "row_count": 12,
    "error": null
  },
  "explanation": {
    "status": "success",
    "message": "Successfully retrieved 12 data points...",
    "data_summary": {
      "total_rows": 12,
      "sample_data": [...],
      "all_data": [...]
    }
  }
}
```

#### GET /api/dashboard
Get metadata about available dimensions and data.

**Response:**
```json
{
  "status": "ready",
  "tables_loaded": ["gold_dim_typ", "gold_dim_polozka", "gold_dim_date", "gold_fact_financials"],
  "dimension_values": {
    "types": ["Revenue", "Náklady", "Rozvaha"],
    "segments": ["Retail", "Corporate", "Treasury", ...],
    "categories": [...],
    "item_count": 28,
    "months": ["Leden", "Únor", ...],
    "quarters": ["Q1", "Q2", "Q3", "Q4"]
  }
}
```

## Semantic Mapping Rules

The LLM uses these rules to map visual elements to the database:

### Time Axis
- Czech month names (Leden, Únor, etc.) → `gold_dim_date.mesic_nazev`
- Quarters (Q1, Q2, etc.) → `gold_dim_date.kvartal`
- Date codes (2025-01) → `gold_dim_date.mesic_kod`

### Categories (Legend Items)
- "Revenue" → `gold_dim_typ.typ_nazev = 'Revenue'`
- "Náklady" → `gold_dim_typ.typ_nazev = 'Náklady'`

### Line/Bar Items (Specific Names)
- "Retailové úvěry & hypotéky" → `gold_dim_polozka.polozka_nazev`
- Includes segment context (Retail, Corporate, etc.)

### Values
- Numbers in "mil. Kč" → `gold_fact_financials.hodnota_mil_kc`
- Profit impact → `gold_fact_financials.profit_kontribuce_mil_kc`

## Chain-of-Thought Reasoning

The system uses a 5-step operational protocol:

1. **Visual Extraction**: Analyze charts, titles, legends, and axis labels
2. **Semantic Mapping**: Match visual labels to database schema
3. **Query Generation**: Generate DuckDB-compatible SQL
4. **Query Listing**: Output `SQL_QUERY:` section with executable SQL
5. **Analysis**: Identify snapshot vs. trend and adjust aggregations

## Security

### Query Validation
- Only SELECT statements allowed
- Forbidden keywords blocked: INSERT, UPDATE, DELETE, DROP, ALTER, etc.
- Must reference gold tables only
- No semicolons (prevents multi-statement injection)

### Row Limiting
- Default limit: 500 rows
- Can be customized in query

## Examples

### Example 1: Revenue by Item
```
User Query: "Show me revenue by product line in Q1 2025"

System Output:
SQL_QUERY: SELECT gp.polozka_nazev, SUM(gf.hodnota_mil_kc) 
           FROM gold_fact_financials gf
           JOIN gold_dim_polozka gp ON gf.polozka_key = gp.polozka_key
           WHERE gp.typ = 'Revenue' AND gf.kvartal = 'Q1'
           GROUP BY gp.polozka_nazev

Result: 10 rows of revenue items with totals
```

### Example 2: Cost Trends
```
User Query: "What are our operating costs trending like?"

System Output:
SQL_QUERY: SELECT gd.mesic_nazev, SUM(gf.hodnota_mil_kc) as monthly_costs
           FROM gold_fact_financials gf
           JOIN gold_dim_date gd ON gf.date_key = gd.date_key
           WHERE gf.typ_key = 2 AND gd.rok = 2025
           GROUP BY gd.mesic_nazev
           ORDER BY gd.mesic_cislo

Result: 12 rows showing monthly cost trends
```

## Testing

Run the comprehensive test suite:

```bash
node scripts/test-semantic-dashboard.mjs
```

**Test Coverage:**
- ✅ CSV loading and table initialization
- ✅ Dimension value extraction
- ✅ SQL query validation
- ✅ Query execution
- ✅ Dashboard metadata endpoint
- ✅ Sample business queries
- ✅ API key configuration check

## Troubleshooting

### ANTHROPIC_API_KEY not set
**Error:** Vision analysis fails
**Solution:** 
```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

### CSV files not found
**Error:** "File not found" in logs
**Solution:** Verify dashboard_files/ directory exists with:
- gold_dim_typ.csv
- gold_dim_polozka.csv
- gold_dim_date 1.csv (note the space)
- gold_fact_financials.csv

### Query validation fails
**Error:** "Statement contains forbidden keywords"
**Solution:** Ensure query only contains SELECT, not INSERT/UPDATE/DELETE/ALTER

### Table not found errors
**Error:** "Table must reference a gold table"
**Solution:** Valid tables are:
- gold_dim_typ
- gold_dim_polozka
- gold_dim_date
- gold_fact_financials

## Performance Notes

- CSV files loaded into memory on each request (fast for small datasets)
- In-memory filtering and sorting (~1-5ms for typical queries)
- Claude Vision API call: ~2-5 seconds (depends on image complexity)
- Total response time: ~3-8 seconds for typical dashboard analysis

## Future Enhancements

- [ ] DuckDB WASM for larger datasets
- [ ] Query result caching
- [ ] Batch image analysis
- [ ] Custom dimension hierarchies
- [ ] Real-time data sync from Supabase
- [ ] Dashboard template library

## Files

```
lib/
  duckdb-connector.js          # CSV loading and query execution
  semantic-interpreter.js      # Claude Vision + semantic mapping

app/api/dashboard/
  route.ts                     # API endpoint

scripts/
  test-semantic-dashboard.mjs  # Test suite

dashboard_files/
  gold_dim_typ.csv
  gold_dim_polozka.csv
  gold_dim_date 1.csv
  gold_fact_financials.csv
```

## Support

For issues or questions:
1. Check the test script output for diagnostic info
2. Review the LLM analysis in the response for reasoning
3. Verify SQL query syntax in the response
4. Check that ANTHROPIC_API_KEY is set

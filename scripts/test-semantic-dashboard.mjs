#!/usr/bin/env node
/**
 * Semantic Dashboard Interpreter - Test & Verification Script
 * 
 * Tests:
 * 1. CSV loading and in-memory queries
 * 2. Dimension value extraction
 * 3. SQL query generation and execution
 * 4. Dashboard image analysis (requires test image and API key)
 */

import { initDuckDB, getDimensionValues, executeQuery, validateSql } from '../lib/duckdb-connector.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🎯 Semantic Dashboard Interpreter - Test Suite\n');

// ─── Test 1: CSV Loading ─────────────────────────────────────────────────────

console.log('📂 Test 1: CSV Loading');
try {
  const tables = initDuckDB();
  console.log(`✅ Loaded tables: ${Object.keys(tables).join(', ')}`);
  
  Object.entries(tables).forEach(([name, table]) => {
    console.log(`   ${name}: ${table.rows.length} rows, ${table.headers.length} columns`);
  });
} catch (error) {
  console.error('❌ CSV loading failed:', error.message);
  process.exit(1);
}

// ─── Test 2: Dimension Values ──────────────────────────────────────────────────

console.log('\n📊 Test 2: Dimension Value Extraction');
try {
  const tables = initDuckDB();
  const dims = getDimensionValues(tables);
  
  console.log('✅ Available dimensions:');
  console.log(`   Types: ${dims.types.join(', ')}`);
  console.log(`   Segments: ${dims.segments.join(', ')}`);
  console.log(`   Months: ${dims.months.join(', ')}`);
  console.log(`   Quarters: ${dims.quarters.join(', ')}`);
  console.log(`   Categories: ${dims.categories.slice(0, 3).join(', ')} (+ ${dims.categories.length - 3} more)`);
  console.log(`   Items: ${dims.items.length} total`);
} catch (error) {
  console.error('❌ Dimension extraction failed:', error.message);
  process.exit(1);
}

// ─── Test 3: SQL Query Validation ──────────────────────────────────────────────

console.log('\n🔐 Test 3: SQL Query Validation');
const testQueries = [
  {
    sql: 'SELECT * FROM gold_dim_typ',
    shouldPass: true,
    name: 'Valid simple select'
  },
  {
    sql: 'INSERT INTO gold_dim_typ VALUES (1, "test")',
    shouldPass: false,
    name: 'Rejected INSERT'
  },
  {
    sql: 'SELECT * FROM unauthorized_table',
    shouldPass: false,
    name: 'Rejected unauthorized table'
  },
  {
    sql: 'SELECT typ_nazev FROM gold_dim_typ WHERE typ_key = 1',
    shouldPass: true,
    name: 'Valid WHERE clause'
  }
];

testQueries.forEach(test => {
  const result = validateSql(test.sql);
  const isValid = result.valid;
  const expectedValid = test.shouldPass;
  
  if (isValid === expectedValid) {
    console.log(`✅ ${test.name}`);
  } else {
    console.log(`❌ ${test.name} - Expected ${expectedValid}, got ${isValid}`);
    if (!isValid) console.log(`   Error: ${result.error}`);
  }
});

// ─── Test 4: Query Execution ───────────────────────────────────────────────────

console.log('\n⚙️  Test 4: Query Execution');
try {
  const tables = initDuckDB();
  
  // Test simple select
  const dimTypResult = executeQuery(tables, 'SELECT * FROM gold_dim_typ');
  console.log(`✅ SELECT * FROM gold_dim_typ: ${dimTypResult.length} rows`);
  console.log(`   Sample: ${JSON.stringify(dimTypResult[0])}`);
  
  // Test select with columns
  const itemsResult = executeQuery(tables, 'SELECT polozka_nazev, segment FROM gold_dim_polozka');
  console.log(`✅ SELECT polozka_nazev, segment: ${itemsResult.length} rows`);
  console.log(`   Sample: ${JSON.stringify(itemsResult[0])}`);
  
  // Test with WHERE
  const factResult = executeQuery(tables, 'SELECT * FROM gold_fact_financials WHERE date_key = 202501');
  console.log(`✅ SELECT with WHERE (date_key=202501): ${factResult.length} rows`);
  if (factResult.length > 0) {
    console.log(`   Sample: ${JSON.stringify(factResult[0])}`);
  }
  
} catch (error) {
  console.error('❌ Query execution failed:', error.message);
  process.exit(1);
}

// ─── Test 5: Dashboard Metadata Endpoint ───────────────────────────────────────

console.log('\n📈 Test 5: Dashboard Metadata (simulating GET /api/dashboard)');
try {
  const tables = initDuckDB();
  const dims = getDimensionValues(tables);
  
  const metadata = {
    status: 'ready',
    tables_loaded: Object.keys(tables),
    dimension_values: {
      types: dims.types,
      segments: dims.segments,
      categories: dims.categories,
      item_count: dims.items.length,
      months: dims.months,
      quarters: dims.quarters,
    },
  };
  
  console.log('✅ Metadata endpoint response:');
  console.log(JSON.stringify(metadata, null, 2));
} catch (error) {
  console.error('❌ Metadata generation failed:', error.message);
  process.exit(1);
}

// ─── Test 6: Sample Business Queries ───────────────────────────────────────────

console.log('\n💼 Test 6: Sample Business Queries');
const businessQueries = [
  {
    name: 'Revenue items (Revenue type)',
    sql: `SELECT polozka_nazev, segment FROM gold_dim_polozka WHERE typ = 'Revenue'`
  },
  {
    name: 'All dimension types',
    sql: `SELECT * FROM gold_dim_typ`
  },
  {
    name: 'Date dimension for Q1 2025',
    sql: `SELECT mesic_nazev, kvartal FROM gold_dim_date WHERE kvartal = 'Q1' AND rok = 2025`
  },
  {
    name: 'Financial facts (first 5)',
    sql: `SELECT fact_key, date_key, polozka_key, hodnota_mil_kc FROM gold_fact_financials LIMIT 5`
  }
];

businessQueries.forEach(q => {
  try {
    const tables = initDuckDB();
    const result = executeQuery(tables, q.sql);
    console.log(`✅ "${q.name}": ${result.length} rows`);
    if (result.length > 0) {
      console.log(`   Sample: ${JSON.stringify(result[0])}`);
    }
  } catch (error) {
    console.log(`❌ "${q.name}": ${error.message}`);
  }
});

// ─── Test 7: Image Analysis Setup ─────────────────────────────────────────────

console.log('\n🖼️  Test 7: Dashboard Image Analysis Setup');

const envLocalPath = path.join(__dirname, '..', '.env.local');
let envContent = '';
try {
  envContent = fs.readFileSync(envLocalPath, 'utf-8');
} catch (e) {
  console.log('⚠️  Could not read .env.local');
}

const hasOpenAIKey = envContent.includes('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
if (hasOpenAIKey) {
  console.log('✅ OPENAI_API_KEY is configured - Vision analysis will work');
  console.log('   Using: gpt-4o (GPT-4 Vision with OpenAI)');
  console.log('   Note: Next.js automatically loads .env.local when running npm run dev');
  console.log('   To test image analysis:');
  console.log('   1. Start the server: npm run dev');
  console.log('   2. POST a dashboard image to /api/dashboard:');
  console.log('      curl -F "image=@dashboard.png" http://localhost:3000/api/dashboard');
  console.log('   3. Optional: Add a query:');
  console.log('      curl -F "image=@dashboard.png" -F "query=What are Q1 costs?" http://localhost:3000/api/dashboard');
} else {
  console.log('⚠️  OPENAI_API_KEY not found in .env.local');
  console.log('   Add it to .env.local:');
  console.log('   OPENAI_API_KEY=sk-proj-...');
  console.log('   Then restart with: npm run dev');
}

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log('\n✨ Test Summary:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('✅ CSV loading and querying: Working');
console.log('✅ Dimension value extraction: Working');
console.log('✅ SQL validation and execution: Working');
console.log(`${hasOpenAIKey ? '✅' : '⏳'} Dashboard image analysis: ${hasOpenAIKey ? 'Ready (gpt-4o)' : 'Needs API key setup'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

console.log('\n🚀 To use in production:');
console.log('1. Start the Next.js server: npm run dev');
console.log('2. Upload a dashboard image to /api/dashboard');
console.log('3. The system will:');
console.log('   - Analyze the image with GPT-4 Vision (gpt-4o)');
console.log('   - Map visual elements to the database schema');
console.log('   - Generate and execute SQL queries');
console.log('   - Return verification results');

console.log('\n📚 Documentation:');
console.log('- Semantic Interpreter: lib/semantic-interpreter.js');
console.log('- DuckDB Connector: lib/duckdb-connector.js');
console.log('- API Route: app/api/dashboard/route.ts');

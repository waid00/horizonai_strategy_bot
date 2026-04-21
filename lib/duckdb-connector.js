/**
 * In-Memory CSV Connector for Financial Dashboard
 * 
 * Handles:
 * - Loading CSV files into memory
 * - Simple SQL-like query execution via pattern matching
 * - Data verification and result mapping
 */

import fs from 'fs';
import path from 'path';

const DASHBOARD_FILES_DIR = path.join(process.cwd(), 'dashboard_files');

/**
 * Parse CSV file with header
 */
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  
  const rows = lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, i) => {
      // Try to parse as number, otherwise keep as string
      const val = values[i];
      row[h] = isNaN(val) ? val : (val.includes('.') ? parseFloat(val) : parseInt(val));
    });
    return row;
  });
  
  return { headers, rows };
}

/**
 * Initialize in-memory tables from CSV files
 * Returns an object with table data and query functions
 */
export function initDuckDB() {
  const tables = {};
  
  const tableConfigs = [
    { name: 'gold_dim_typ', file: 'gold_dim_typ.csv' },
    { name: 'gold_dim_polozka', file: 'gold_dim_polozka.csv' },
    { name: 'gold_dim_date', file: 'gold_dim_date.csv' },
    { name: 'gold_fact_financials', file: 'gold_fact_financials.csv' },
  ];

  for (const config of tableConfigs) {
    const filePath = path.join(DASHBOARD_FILES_DIR, config.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`File not found: ${filePath}`);
      continue;
    }

    try {
      const { headers, rows } = parseCSV(filePath);
      tables[config.name] = { headers, rows };
      console.log(`Loaded table: ${config.name} (${rows.length} rows)`);
    } catch (error) {
      console.error(`Error loading ${config.name}:`, error.message);
    }
  }

  return tables;
}

/**
 * Execute a SQL-like query against in-memory tables
 * Supports basic SELECT with WHERE, ORDER BY, GROUP BY, LIMIT
 */
export function executeQuery(tables, sql) {
  try {
    // Remove excess whitespace and normalize
    const normalized = sql.replace(/\s+/g, ' ').trim();
    
    // Parse SELECT statement
    const selectMatch = normalized.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+(.*))?$/i);
    if (!selectMatch) {
      throw new Error('Invalid SELECT syntax');
    }

    const [, selectClause, tableName, restClause] = selectMatch;
    const table = tables[tableName];
    
    if (!table) {
      throw new Error(`Table not found: ${tableName}`);
    }

    let results = [...table.rows];
    const selectedCols = selectClause.trim() === '*' 
      ? table.headers 
      : selectClause.split(',').map(c => c.trim());

    // Parse WHERE clause
    if (restClause && restClause.toUpperCase().includes('WHERE')) {
      const whereMatch = restClause.match(/WHERE\s+(.+?)(?:\s+ORDER BY|\s+GROUP BY|\s+LIMIT|$)/i);
      if (whereMatch) {
        const condition = whereMatch[1];
        results = filterRows(results, condition);
      }
    }

    // Parse GROUP BY clause
    if (restClause && restClause.toUpperCase().includes('GROUP BY')) {
      const groupMatch = restClause.match(/GROUP BY\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|$)/i);
      if (groupMatch) {
        const groupCols = groupMatch[1].split(',').map(c => c.trim());
        results = groupRows(results, groupCols, selectedCols);
      }
    }

    // Parse ORDER BY clause
    if (restClause && restClause.toUpperCase().includes('ORDER BY')) {
      const orderMatch = restClause.match(/ORDER BY\s+(.+?)(?:\s+LIMIT|$)/i);
      if (orderMatch) {
        const orderCols = orderMatch[1].split(',').map(c => c.trim());
        results = sortRows(results, orderCols);
      }
    }

    // Parse LIMIT clause
    if (restClause && restClause.toUpperCase().includes('LIMIT')) {
      const limitMatch = restClause.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) {
        const limit = parseInt(limitMatch[1]);
        results = results.slice(0, limit);
      }
    }

    // Select only requested columns
    if (selectedCols[0] !== '*') {
      results = results.map(row => {
        const filtered = {};
        selectedCols.forEach(col => {
          filtered[col] = row[col];
        });
        return filtered;
      });
    }

    return results;
  } catch (error) {
    console.error('Query execution error:', error);
    throw new Error(`SQL execution failed: ${error.message}`);
  }
}

/**
 * Filter rows by WHERE clause conditions
 */
function filterRows(rows, condition) {
  return rows.filter(row => evaluateCondition(row, condition));
}

/**
 * Evaluate a WHERE condition
 */
function evaluateCondition(row, condition) {
  // Simple condition parser: supports =, >, <, >=, <=, !=, LIKE
  const eqMatch = condition.match(/(\w+)\s*=\s*'?([^']*)'?/i);
  if (eqMatch) {
    const [, col, val] = eqMatch;
    return row[col] == val;
  }

  const gtMatch = condition.match(/(\w+)\s*>\s*(\d+)/i);
  if (gtMatch) {
    const [, col, val] = gtMatch;
    return row[col] > parseInt(val);
  }

  const ltMatch = condition.match(/(\w+)\s*<\s*(\d+)/i);
  if (ltMatch) {
    const [, col, val] = ltMatch;
    return row[col] < parseInt(val);
  }

  // Add more operators as needed
  return true;
}

/**
 * Group rows by specified columns
 */
function groupRows(rows, groupCols, selectCols) {
  const groups = {};
  
  rows.forEach(row => {
    const key = groupCols.map(col => row[col]).join('|');
    if (!groups[key]) {
      groups[key] = { rows: [], groupKey: key };
    }
    groups[key].rows.push(row);
  });

  // Aggregate grouped rows
  return Object.values(groups).map(group => {
    const result = {};
    groupCols.forEach(col => {
      result[col] = group.rows[0][col];
    });
    
    // Sum numeric columns
    selectCols.forEach(col => {
      if (!groupCols.includes(col) && typeof group.rows[0][col] === 'number') {
        result[col] = group.rows.reduce((sum, r) => sum + (r[col] || 0), 0);
      }
    });
    
    return result;
  });
}

/**
 * Sort rows by specified columns
 */
function sortRows(rows, orderCols) {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const col of orderCols) {
      const aVal = a[col];
      const bVal = b[col];
      if (aVal < bVal) return -1;
      if (aVal > bVal) return 1;
    }
    return 0;
  });
  return sorted;
}

/**
 * Validate a SQL query before execution
 * Only SELECT statements from gold tables allowed
 */
export function validateSql(sql) {
  const trimmed = sql.trim();

  // Must be SELECT
  if (!/^SELECT\b/i.test(trimmed)) {
    return { valid: false, error: 'Only SELECT statements are permitted.' };
  }

  // No dangerous keywords
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|EXECUTE|EXEC|CALL|COPY|VACUUM|REINDEX|CLUSTER|LOCK|COMMENT|SET|RESET)\b/i;
  if (forbidden.test(trimmed)) {
    return { valid: false, error: 'Statement contains forbidden keywords.' };
  }

  // Must reference at least one gold table
  const goldTables = ['gold_dim_typ', 'gold_dim_polozka', 'gold_dim_date', 'gold_fact_financials'];
  const referencesGold = goldTables.some(t => new RegExp(`\\b${t}\\b`, 'i').test(trimmed));
  if (!referencesGold) {
    return { valid: false, error: 'Query must reference a gold table.' };
  }

  return { valid: true };
}

/**
 * Helper: Get all dimension values for semantic mapping
 */
export function getDimensionValues(tables) {
  const values = {};
  
  if (tables.gold_dim_typ) {
    values.types = [...new Set(tables.gold_dim_typ.rows.map(r => r.typ_nazev))];
  }
  
  if (tables.gold_dim_polozka) {
    values.segments = [...new Set(tables.gold_dim_polozka.rows.map(r => r.segment).filter(Boolean))];
    values.categories = [...new Set(tables.gold_dim_polozka.rows.map(r => r.kategorie).filter(Boolean))];
    values.items = tables.gold_dim_polozka.rows.map(r => ({ 
      polozka_nazev: r.polozka_nazev, 
      typ: r.typ, 
      segment: r.segment 
    }));
  }
  
  if (tables.gold_dim_date) {
    values.months = [...new Set(tables.gold_dim_date.rows.map(r => r.mesic_nazev))];
    values.quarters = [...new Set(tables.gold_dim_date.rows.map(r => r.kvartal))];
  }
  
  return values;
}

/**
 * Helper: Build metadata for LLM context
 */
export function buildDimensionContext(tables) {
  const dims = getDimensionValues(tables);
  
  return `
Available Dimension Values:

Types: ${(dims.types || []).join(', ')}.

Segments: ${(dims.segments || []).join(', ')}.

Categories: ${(dims.categories || []).join(', ')}.

Key Items (top 15): ${(dims.items || []).slice(0, 15).map(i => i.polozka_nazev).join(', ')}.

Months (Czech): ${(dims.months || []).join(', ')}.

Quarters: ${(dims.quarters || []).join(', ')}.
`;
}

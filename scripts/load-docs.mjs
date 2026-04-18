import fs from "fs";
import path from "path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

/**
 * Detects the field delimiter used in a CSV file by inspecting the first line.
 * Preference order: tab → semicolon → comma.
 * European CSV exports (e.g. Czech locale) commonly use semicolons; tab-separated
 * exports are also frequent.  Comma is the fallback for standard RFC 4180 files.
 */
function detectDelimiter(firstLine) {
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const semicolonCount = (firstLine.match(/;/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;

  if (tabCount > 0 && tabCount >= semicolonCount && tabCount >= commaCount) return "\t";
  if (semicolonCount > 0 && semicolonCount >= commaCount) return ";";
  return ",";
}

/**
 * Parse a single CSV line using the given delimiter, respecting double-quoted
 * fields that may contain the delimiter character or newlines.
 */
function parseCsvLine(line, delimiter = ",") {
  const fields = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        // Escaped double-quote inside a quoted field
        field += '"';
        i += 2;
      } else if (ch === '"') {
        inQuotes = false;
        i++;
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      fields.push(field.trim());
      field = "";
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  fields.push(field.trim());
  return fields;
}

/**
 * Converts a CSV string into an array of self-contained natural language
 * sentences so that every RAG chunk carries full column context.
 *
 * Automatically detects the delimiter (tab, semicolon, or comma) from the
 * first non-empty line.
 *
 * Example input (semicolon-delimited):
 *   KPI;Current State;Target State
 *   Active Digital Clients;55%;80%
 *   Cost-to-Income;60%;40%
 *
 * Example output:
 *   "KPI 'Active Digital Clients': Current State is 55%, Target State is 80%."
 *   "KPI 'Cost-to-Income': Current State is 60%, Target State is 40%."
 */
function csvToProse(raw) {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return null; // no data rows

  const delimiter = detectDelimiter(nonEmpty[0]);
  const headers = parseCsvLine(nonEmpty[0], delimiter);
  const sentences = [];

  for (let i = 1; i < nonEmpty.length; i++) {
    const values = parseCsvLine(nonEmpty[i], delimiter);

    // Build key-value pairs for all columns
    const pairs = headers
      .map((h, idx) => {
        const v = (values[idx] ?? "").trim();
        return h.trim() && v ? { header: h.trim(), value: v } : null;
      })
      .filter(Boolean);

    if (pairs.length === 0) continue;

    // Generate a natural language sentence:
    //   "[header0] '[value0]': [header1] is [value1], [header2] is [value2]."
    // When there is only one column, just emit "header: value".
    let sentence;
    if (pairs.length === 1) {
      sentence = `${pairs[0].header}: ${pairs[0].value}.`;
    } else {
      const subject = `${pairs[0].header} '${pairs[0].value}'`;
      const predicates = pairs
        .slice(1)
        .map((p) => `${p.header} is ${p.value}`)
        .join(", ");
      sentence = `${subject}: ${predicates}.`;
    }

    sentences.push(sentence);
  }

  return sentences;
}

/**
 * Place your documents in a /docs folder in the project root.
 * Supported formats: .pdf, .docx, .txt, .md, .csv
 * Returns array of { content, metadata } objects ready for ingestion.
 *
 * CSV files are converted to prose (one sentence per row) so that every
 * chunk retrieved by the RAG system carries full column context.
 */
export async function loadDocumentsFromFolder(folderPath = "./docs") {
  const files = fs.readdirSync(folderPath);
  const documents = [];

  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const ext = path.extname(file).toLowerCase();
    let content = "";

    try {
      if (ext === ".pdf") {
        const buffer = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: buffer });
        const parsed = await parser.getText();
        await parser.destroy();
        content = parsed.text;
        console.log(`📄 Loaded PDF: ${file} (${content.length} chars)`);

      } else if (ext === ".docx") {
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value;
        console.log(`📄 Loaded DOCX: ${file} (${content.length} chars)`);

      } else if (ext === ".csv") {
        const raw = fs.readFileSync(filePath, "utf-8");
        const sentences = csvToProse(raw);
        if (!sentences || sentences.length === 0) {
          console.log(`⚠️  Skipped empty/header-only CSV: ${file}`);
          continue;
        }
        // Group rows into chunks of ~10 so each chunk stays focused.
        const ROWS_PER_CHUNK = 10;
        for (let i = 0; i < sentences.length; i += ROWS_PER_CHUNK) {
          const chunkContent = sentences.slice(i, i + ROWS_PER_CHUNK).join("\n");
          documents.push({ content: chunkContent, metadata: { domain: "Custom", source: file, tags: ["csv"] } });
        }
        console.log(`📊 Loaded CSV: ${file} (${sentences.length} rows → ${Math.ceil(sentences.length / ROWS_PER_CHUNK)} chunks)`);
        continue; // already pushed; skip the generic push below

      } else if (ext === ".txt" || ext === ".md") {
        content = fs.readFileSync(filePath, "utf-8");
        console.log(`📄 Loaded ${ext.toUpperCase().slice(1)}: ${file} (${content.length} chars)`);

      } else {
        console.log(`⚠️  Skipped unsupported file: ${file}`);
        continue;
      }

      // Normalize whitespace while preserving line breaks for chunking.
      content = content
        .replace(/\r\n/g, "\n")
        .replace(/\t/g, " ")
        .replace(/[ ]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (content.length < 50) {
        console.log(`⚠️  Skipped empty file: ${file}`);
        continue;
      }

      documents.push({
        content,
        metadata: {
          domain: "Custom",           // change this per document if needed
          source: file,               // filename becomes the source
          tags: [ext.replace(".", "")]
        },
      });

    } catch (err) {
      console.error(`❌ Failed to load ${file}: ${err.message}`);
    }
  }

  return documents;
}
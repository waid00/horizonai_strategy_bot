import fs from "fs";
import path from "path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

/**
 * Parse a single CSV line, respecting double-quoted fields that may
 * contain commas or newlines.
 */
function parseCsvLine(line) {
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
    } else if (ch === ",") {
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
 * Convert a CSV string into an array of prose sentences.
 * Each row becomes:  "Header1: Value1 | Header2: Value2 | ..."
 * This gives every RAG chunk full column context.
 */
function csvToProse(raw) {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return null; // no data rows

  const headers = parseCsvLine(nonEmpty[0]);
  const sentences = [];

  for (let i = 1; i < nonEmpty.length; i++) {
    const values = parseCsvLine(nonEmpty[i]);
    const parts = headers
      .map((h, idx) => {
        const v = (values[idx] ?? "").trim();
        return v.length > 0 ? `${h}: ${v}` : null;
      })
      .filter(Boolean);
    if (parts.length > 0) sentences.push(parts.join(" | "));
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
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

export const DOCS_ROOT = path.join(process.cwd(), "docs");
export const UPLOAD_ROOT = path.join(process.cwd(), "data", "uploads");

export const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md", ".csv"]);

export function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function parseStoredName(storedName) {
  const match = storedName.match(/^[a-f0-9]{24}__(.+)$/);
  if (!match) return { originalName: null };
  return { originalName: match[1] };
}

export function computeDocumentId(location, storedName) {
  return crypto.createHash("sha1").update(`${location}:${storedName}`).digest("hex");
}

function normalizeDocumentText(content) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getPDFParseClass() {
  try {
    const pdfModule = require("pdf-parse");
    const PDFParseCtor = pdfModule.PDFParse ?? pdfModule.default?.PDFParse ?? pdfModule;

    if (!PDFParseCtor) {
      throw new Error("pdf-parse does not expose PDFParse in this runtime");
    }

    return PDFParseCtor;
  } catch (err) {
    throw new Error(`Failed to load pdf-parse: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function getMammothExtractRawText() {
  try {
    const mammothModule = require("mammoth");
    const extractRawText = mammothModule.extractRawText ?? mammothModule.default?.extractRawText;

    if (!extractRawText) {
      throw new Error("mammoth extractRawText is not available in this runtime");
    }

    return extractRawText;
  } catch (err) {
    throw new Error(`Failed to load mammoth: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readDocumentText(filePath, extension) {
  if (extension === ".pdf") {
    const PDFParse = await getPDFParseClass();
    const buffer = await fs.readFile(filePath);
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    return parsed.text;
  }

  if (extension === ".docx") {
    const extractRawText = await getMammothExtractRawText();
    const result = await extractRawText({ path: filePath });
    return result.value;
  }

  return fs.readFile(filePath, "utf-8");
}

export async function listDocuments() {
  const directories = [
    { location: "docs", folderPath: DOCS_ROOT },
    { location: "uploads", folderPath: UPLOAD_ROOT },
  ];

  const items = [];

  for (const directory of directories) {
    try {
      const entries = await fs.readdir(directory.folderPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const extension = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(extension)) continue;

        const fullPath = path.join(directory.folderPath, entry.name);
        const stat = await fs.stat(fullPath);
        const parsed = parseStoredName(entry.name);
        const originalName = directory.location === "uploads" ? parsed.originalName ?? entry.name : entry.name;

        items.push({
          id: computeDocumentId(directory.location, entry.name),
          originalName,
          storedName: entry.name,
          extension,
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          location: directory.location,
        });
      }
    } catch {
      // Ignore missing directories so the app can run with partial data.
    }
  }

  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function resolveDocumentById(documentId) {
  const documents = await listDocuments();
  return documents.find((document) => document.id === documentId) ?? null;
}

export async function loadDocumentSource(document) {
  const folderPath = document.location === "uploads" ? UPLOAD_ROOT : DOCS_ROOT;
  const fullPath = path.join(folderPath, document.storedName);
  const rawText = await readDocumentText(fullPath, document.extension);
  const text = normalizeDocumentText(rawText);

  return {
    ...document,
    fullPath,
    text,
  };
}

export function normalizeForComparison(text) {
  return normalizeDocumentText(text);
}

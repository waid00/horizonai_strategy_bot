import fs from "fs";
import path from "path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

/**
 * Place your documents in a /docs folder in the project root.
 * Supported formats: .pdf, .docx, .txt, .md, .csv
 * Returns array of { content, metadata } objects ready for ingestion.
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

      } else if (ext === ".txt" || ext === ".md" || ext === ".csv") {
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
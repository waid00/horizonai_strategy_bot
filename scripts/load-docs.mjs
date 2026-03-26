import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

/**
 * Place your documents in a /docs folder in the project root.
 * Supported formats: .pdf, .docx, .txt
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
        const parsed = await pdfParse(buffer);
        content = parsed.text;
        console.log(`📄 Loaded PDF: ${file} (${content.length} chars)`);

      } else if (ext === ".docx") {
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value;
        console.log(`📄 Loaded DOCX: ${file} (${content.length} chars)`);

      } else if (ext === ".txt") {
        content = fs.readFileSync(filePath, "utf-8");
        console.log(`📄 Loaded TXT: ${file} (${content.length} chars)`);

      } else {
        console.log(`⚠️  Skipped unsupported file: ${file}`);
        continue;
      }

      // Clean up whitespace
      content = content.replace(/\s+/g, " ").trim();

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
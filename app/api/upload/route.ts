import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";

const UPLOAD_ROOT = path.join(process.cwd(), "data", "uploads");
const DOCS_ROOT = path.join(process.cwd(), "docs");
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md", ".csv"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type ListedFile = {
  id: string;
  originalName: string;
  storedName: string;
  extension: string;
  size: number;
  createdAt: string;
  location: "uploads" | "docs";
};

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function ensureUploadRoot() {
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
}

async function listDirectoryFiles(dirPath: string, location: "uploads" | "docs") {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const fileEntries = entries.filter((entry) => entry.isFile());

    const listed = await Promise.all(
      fileEntries
        .filter((entry) => ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map(async (entry) => {
          const fullPath = path.join(dirPath, entry.name);
          const stat = await fs.stat(fullPath);

          const parsed = parseStoredName(entry.name);
          const originalName = parsed.originalName ?? entry.name;

          const item: ListedFile = {
            id: crypto.createHash("sha1").update(`${location}:${entry.name}`).digest("hex"),
            originalName,
            storedName: entry.name,
            extension: path.extname(entry.name).toLowerCase(),
            size: stat.size,
            createdAt: stat.birthtime.toISOString(),
            location,
          };

          return item;
        })
    );

    return listed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [] as ListedFile[];
  }
}

function parseStoredName(storedName: string) {
  const match = storedName.match(/^[a-f0-9]{24}__(.+)$/);
  if (!match) return { originalName: null };
  return { originalName: match[1] };
}

export async function GET() {
  await ensureUploadRoot();

  const [uploads, docs] = await Promise.all([
    listDirectoryFiles(UPLOAD_ROOT, "uploads"),
    listDirectoryFiles(DOCS_ROOT, "docs"),
  ]);

  return NextResponse.json({
    uploads,
    docs,
    acceptedExtensions: Array.from(ALLOWED_EXTENSIONS),
    maxFileBytes: MAX_FILE_BYTES,
  });
}

export async function POST(req: NextRequest) {
  await ensureUploadRoot();

  const formData = await req.formData();
  const allEntries = formData.getAll("files");

  const files = allEntries.filter((value): value is File => value instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "No files submitted in field 'files'." }, { status: 400 });
  }

  const saved: ListedFile[] = [];
  const rejected: Array<{ file: string; reason: string }> = [];

  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      rejected.push({ file: file.name, reason: `Unsupported file type ${ext || "(none)"}` });
      continue;
    }

    if (file.size > MAX_FILE_BYTES) {
      rejected.push({ file: file.name, reason: `File exceeds ${MAX_FILE_BYTES} bytes` });
      continue;
    }

    const randomPrefix = crypto.randomBytes(12).toString("hex");
    const originalSafeName = sanitizeFileName(file.name);
    const storedName = `${randomPrefix}__${originalSafeName}`;
    const destPath = path.join(UPLOAD_ROOT, storedName);

    const bytes = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(destPath, bytes);

    const stat = await fs.stat(destPath);

    saved.push({
      id: crypto.createHash("sha1").update(`uploads:${storedName}`).digest("hex"),
      originalName: file.name,
      storedName,
      extension: ext,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      location: "uploads",
    });
  }

  const status = saved.length > 0 ? 200 : 400;
  return NextResponse.json({ saved, rejected }, { status });
}

export async function DELETE(req: NextRequest) {
  await ensureUploadRoot();

  let payload: { storedName?: string };
  try {
    payload = (await req.json()) as { storedName?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const storedName = payload?.storedName;
  if (!storedName || typeof storedName !== "string") {
    return NextResponse.json({ error: "Missing 'storedName'." }, { status: 400 });
  }

  if (storedName.includes("/") || storedName.includes("\\")) {
    return NextResponse.json({ error: "Invalid storedName." }, { status: 400 });
  }

  const targetPath = path.join(UPLOAD_ROOT, storedName);

  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Target is not a file." }, { status: 400 });
    }

    await fs.unlink(targetPath);
    return NextResponse.json({ ok: true, deleted: storedName });
  } catch {
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  }
}

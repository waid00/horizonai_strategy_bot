/**
 * Horizon Bank Strategy Bot – Document Upload Endpoint
 * File: /app/api/upload/route.ts
 *
 * POST /api/upload  – saves an uploaded file to data/uploads/
 * GET  /api/upload  – returns the list of files already in data/uploads/
 *
 * Allowed types: .pdf, .docx, .txt  |  Max size: 20 MB
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Node.js runtime: this route uses the fs module and cannot run on the Edge
export const runtime = "nodejs";

const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".txt"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

// ─── POST: Upload a file ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    ensureUploadsDir();

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const ext = path.extname(file.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: "Unsupported file type. Only .pdf, .docx, and .txt are allowed." },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "File too large. Maximum size is 20 MB." },
        { status: 400 }
      );
    }

    // Sanitise the filename to prevent path traversal and odd characters
    const baseName = path.basename(file.name);
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");

    if (!safeName || safeName === ".gitkeep") {
      return NextResponse.json({ error: "Invalid filename." }, { status: 400 });
    }

    const dest = path.resolve(UPLOADS_DIR, safeName);
    // Double-check the resolved path is still inside UPLOADS_DIR
    if (!dest.startsWith(UPLOADS_DIR + path.sep)) {
      return NextResponse.json({ error: "Invalid filename." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(dest, buffer);

    return NextResponse.json({ ok: true, filename: safeName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── GET: List uploaded files ─────────────────────────────────────────────────

export async function GET() {
  try {
    ensureUploadsDir();

    const files = fs
      .readdirSync(UPLOADS_DIR)
      .filter((f) => f !== ".gitkeep" && !f.startsWith("."))
      .map((f) => {
        const stat = fs.statSync(path.join(UPLOADS_DIR, f));
        return {
          name: f,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));

    return NextResponse.json({ files });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

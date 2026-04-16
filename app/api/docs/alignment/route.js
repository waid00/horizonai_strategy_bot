/**
 * Horizon Bank Strategy Bot – Document Alignment Route (Thin Proxy)
 * File: /app/api/docs/alignment/route.js
 *
 * All AI logic (document loading, chunking, embedding, structured LLM verdict)
 * has moved to the Python PydanticAI agent service (python_agent/server.py).
 *
 * This route:
 *   1. Applies rate limiting (preserved from the original handler).
 *   2. Forwards {docAId, docBId} to the Python service POST /alignment.
 *   3. Returns the JSON payload unchanged to the frontend.
 *
 * Required environment variable:
 *   PYTHON_AGENT_URL  – base URL of the Python service (default: http://localhost:8000)
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const PYTHON_AGENT_URL = process.env.PYTHON_AGENT_URL ?? "http://localhost:8000";

// Rate limiting: max 12 requests per IP per minute (same as the original handler).
const rateLimitMap = new Map();
const LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;

export async function POST(request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anonymous";

  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + LIMIT_WINDOW_MS });
  } else if (entry.count >= MAX_REQUESTS) {
    return NextResponse.json({ error: "Rate limit exceeded." }, { status: 429 });
  } else {
    entry.count += 1;
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const { docAId, docBId } = body ?? {};
  if (!docAId || !docBId) {
    return NextResponse.json(
      { error: "docAId and docBId are required." },
      { status: 400 }
    );
  }

  let pythonResponse;
  try {
    pythonResponse = await fetch(`${PYTHON_AGENT_URL}/alignment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docAId, docBId }),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Python agent service unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 503 }
    );
  }

  const data = await pythonResponse.json();
  return NextResponse.json(data, { status: pythonResponse.status });
}


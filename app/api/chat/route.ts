/**
 * Horizon Bank Strategy Bot – Chat Route (Thin Proxy)
 * File: /app/api/chat/route.ts
 *
 * All AI logic (RAG retrieval, prompt construction, streaming) has moved to the
 * Python PydanticAI agent service (python_agent/server.py).
 *
 * This route:
 *   1. Forwards the JSON body to the Python service POST /chat.
 *   2. The Python service streams SSE in "data: <json-chunk>\n\n" format.
 *   3. createDataStreamResponse converts that into the Vercel AI SDK UI-message
 *      stream protocol expected by the useChat() hook on the frontend.
 *
 * Required environment variable:
 *   PYTHON_AGENT_URL  – base URL of the Python service (default: http://localhost:8000)
 */

import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { NextRequest } from "next/server";

// ─── Runtime Config ──────────────────────────────────────────────────────────
export const runtime = "nodejs";

const PYTHON_AGENT_URL = process.env.PYTHON_AGENT_URL ?? "http://localhost:8000";

// ─── Request Handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Forward the request to the Python PydanticAI agent service.
  let pythonResponse: Response;
  try {
    pythonResponse = await fetch(`${PYTHON_AGENT_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/chat] Python agent service unreachable:", message);
    return new Response(
      JSON.stringify({ error: `Python agent service unavailable: ${message}` }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!pythonResponse.ok) {
    const errText = await pythonResponse.text();
    console.error("[/api/chat] Python agent returned error:", errText);
    return new Response(
      JSON.stringify({ error: `Agent error: ${errText}` }),
      { status: pythonResponse.status, headers: { "Content-Type": "application/json" } }
    );
  }

  // The Python service streams simple SSE: data: <json-encoded-chunk>\n\n
  // createUIMessageStream + createUIMessageStreamResponse converts those text
  // deltas into the Vercel AI SDK UI-message stream protocol expected by useChat().
  const messageStreamId = "response";
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      if (!pythonResponse.body) return;

      const reader = pythonResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let started = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE blocks are delimited by double newlines.
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              if (started) writer.write({ type: "text-end", id: messageStreamId });
              return;
            }
            if (!data) continue;
            // Each chunk is JSON-encoded by the Python service.
            let text: string;
            try {
              text = JSON.parse(data) as string;
              if (typeof text !== "string") continue;
            } catch {
              text = data;
            }
            if (!text) continue;
            if (!started) {
              writer.write({ type: "text-start", id: messageStreamId });
              started = true;
            }
            writer.write({ type: "text-delta", id: messageStreamId, delta: text });
          }
        }
      }

      if (started) writer.write({ type: "text-end", id: messageStreamId });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
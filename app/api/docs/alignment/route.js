/**
 * Horizon Bank Strategy Bot – Document Alignment Route
 * File: /app/api/docs/alignment/route.js
 *
 * Delegates to createDocsAlignmentHandler() from lib/docs-alignment.js which
 * handles rate limiting, document loading, chunking, embedding, cosine
 * similarity ranking, and LLM verdict.
 *
 * Required environment variable:
 *   OPENAI_API_KEY
 */

import { createDocsAlignmentHandler } from "../../../../lib/docs-alignment.js";

export const runtime = "nodejs";

const handler = createDocsAlignmentHandler();

export { handler as POST };


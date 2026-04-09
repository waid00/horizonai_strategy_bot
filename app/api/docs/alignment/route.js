import OpenAI from "openai";
import { createDocsAlignmentHandler } from "../../../../lib/docs-alignment.js";
import { resolveDocumentById } from "../../../../lib/document-store.js";

export const runtime = "nodejs";

const rateLimitMap = new Map();

export const POST = createDocsAlignmentHandler({
  rateLimitMap,
  resolveDocumentById,
  openaiClient: new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" }),
});

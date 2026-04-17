import OpenAI from "openai";
import { createDocsAlignmentHandler } from "../../../../lib/docs-alignment.js";

export const runtime = "nodejs";

const rateLimitMap = new Map();

const handler = createDocsAlignmentHandler({
  rateLimitMap,
  openaiClient: new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" }),
});

export const POST = handler;

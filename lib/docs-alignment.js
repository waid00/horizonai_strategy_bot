import OpenAI from "openai";
import { z } from "zod";
import { loadDocumentSource, normalizeForComparison, resolveDocumentById as defaultResolveDocumentById } from "./document-store.js";

const DEFAULT_CHUNK_SIZE = 4200;
const DEFAULT_OVERLAP = 700;
const DEFAULT_MAX_CHUNKS = 24;
const DEFAULT_TOP_K = 3;
const DEFAULT_EVIDENCE_PAIRS = 12;
const SUPPORT_THRESHOLD = 0.78;
const PARTIAL_THRESHOLD = 0.72;

const AlignmentReasonSchema = z.object({
  text: z.string(),
  citations: z.array(z.string()).min(1),
});

const ContradictionSchema = z.object({
  aChunkId: z.string(),
  bChunkId: z.string(),
  aQuote: z.string(),
  bQuote: z.string(),
  explanation: z.string(),
});

const LlmResponseSchema = z.object({
  verdict: z.enum(["aligned", "partial", "not_aligned", "insufficient_evidence"]),
  reasons: z.array(AlignmentReasonSchema).min(1),
  contradictions: z.array(ContradictionSchema),
  llm_summary: z.string(),
});

export function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = Math.min(options.overlap ?? DEFAULT_OVERLAP, Math.floor(chunkSize * 0.4));
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
  const sourceLabel = options.sourceLabel ?? "doc";
  const normalized = normalizeForComparison(text);
  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);

  if (paragraphs.length === 0) {
    return { chunks: [], warnings: [] };
  }

  const chunks = [];
  const warnings = [];
  let current = "";
  let chunkIndex = 0;

  const pushCurrent = () => {
    const textValue = current.trim();
    if (!textValue) {
      current = "";
      return;
    }

    chunkIndex += 1;
    chunks.push({
      id: `${sourceLabel}:chunk:${String(chunkIndex).padStart(2, "0")}`,
      index: chunkIndex,
      text: textValue,
    });
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      pushCurrent();
      if (chunks.length >= maxChunks) {
        warnings.push(`Chunk cap reached for ${sourceLabel}; later text was truncated.`);
        return { chunks, warnings };
      }

      const tail = current.slice(Math.max(0, current.length - overlap));
      current = `${tail}\n\n${paragraph}`.trim();
      while (current.length > chunkSize) {
        const splitPoint = Math.max(current.lastIndexOf("\n\n", chunkSize), current.lastIndexOf(". ", chunkSize));
        if (splitPoint > Math.floor(chunkSize * 0.5)) {
          current = current.slice(splitPoint + 2).trim();
        } else {
          break;
        }
      }
    } else if (paragraph.length > chunkSize) {
      let start = 0;
      while (start < paragraph.length && chunks.length < maxChunks) {
        const end = Math.min(paragraph.length, start + chunkSize);
        const slice = paragraph.slice(start, end).trim();
        if (slice) {
          chunkIndex += 1;
          chunks.push({
            id: `${sourceLabel}:chunk:${String(chunkIndex).padStart(2, "0")}`,
            index: chunkIndex,
            text: slice,
          });
        }
        start = Math.max(end - overlap, end);
      }
      if (chunks.length >= maxChunks) {
        warnings.push(`Chunk cap reached for ${sourceLabel}; later text was truncated.`);
        return { chunks, warnings };
      }
      current = "";
    } else {
      current = paragraph;
    }
  }

  pushCurrent();

  if (chunks.length > maxChunks) {
    warnings.push(`Chunk cap reached for ${sourceLabel}; later text was truncated.`);
    return { chunks: chunks.slice(0, maxChunks), warnings };
  }

  return { chunks, warnings };
}

export function cosineSimilarity(vectorA, vectorB) {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vectorA.length; i += 1) {
    dot += vectorA[i] * vectorB[i];
    magnitudeA += vectorA[i] * vectorA[i];
    magnitudeB += vectorB[i] * vectorB[i];
  }

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

export function rankSimilarityPairs(aChunks, bChunks, aEmbeddings, bEmbeddings, options = {}) {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const evidencePairsCount = options.evidencePairsCount ?? DEFAULT_EVIDENCE_PAIRS;
  const supportThreshold = options.supportThreshold ?? SUPPORT_THRESHOLD;

  const perA = [];
  const allPairs = [];

  for (let aIndex = 0; aIndex < aChunks.length; aIndex += 1) {
    const scores = [];
    for (let bIndex = 0; bIndex < bChunks.length; bIndex += 1) {
      const score = cosineSimilarity(aEmbeddings[aIndex], bEmbeddings[bIndex]);
      scores.push({
        aIndex,
        bIndex,
        score,
      });
    }

    scores.sort((left, right) => right.score - left.score);
    const topMatches = scores.slice(0, topK).map((match) => ({
      aIndex: match.aIndex,
      bIndex: match.bIndex,
      score: match.score,
      aChunkId: aChunks[match.aIndex].id,
      bChunkId: bChunks[match.bIndex].id,
      aText: aChunks[match.aIndex].text,
      bText: bChunks[match.bIndex].text,
      aChunkIndex: aChunks[match.aIndex].index,
      bChunkIndex: bChunks[match.bIndex].index,
    }));

    perA.push({
      aChunkId: aChunks[aIndex].id,
      topMatches,
      topScore: topMatches[0]?.score ?? 0,
    });

    allPairs.push(...topMatches);
  }

  const uniquePairsMap = new Map();
  for (const pair of allPairs) {
    const key = `${pair.aChunkId}::${pair.bChunkId}`;
    if (!uniquePairsMap.has(key) || uniquePairsMap.get(key).score < pair.score) {
      uniquePairsMap.set(key, pair);
    }
  }

  const topPairs = Array.from(uniquePairsMap.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, evidencePairsCount);

  const supportedChunks = perA.filter((item) => item.topScore >= supportThreshold).length;
  const avgTopK = allPairs.length > 0 ? allPairs.reduce((sum, item) => sum + item.score, 0) / allPairs.length : 0;
  const top = topPairs[0]?.score ?? 0;

  return {
    perA,
    topPairs,
    top,
    avgTopK,
    k: topK,
    supportedChunks,
    supportedRatio: aChunks.length > 0 ? supportedChunks / aChunks.length : 0,
  };
}

export function derivePreliminaryVerdict(metrics) {
  const { top, avgTopK, supportedRatio, supportedChunks } = metrics;

  if (top < PARTIAL_THRESHOLD && supportedChunks === 0) {
    return "insufficient_evidence";
  }

  if (top < SUPPORT_THRESHOLD && supportedRatio < 0.25) {
    return top < PARTIAL_THRESHOLD ? "insufficient_evidence" : "not_aligned";
  }

  if (supportedRatio >= 0.7 && avgTopK >= 0.83) {
    return "aligned";
  }

  if (supportedRatio >= 0.35 || top >= 0.8 || avgTopK >= 0.78) {
    return "partial";
  }

  return "not_aligned";
}

function conservativelyMergeVerdicts(preliminaryVerdict, llmVerdict) {
  const strength = {
    insufficient_evidence: 0,
    not_aligned: 1,
    partial: 2,
    aligned: 3,
  };

  return strength[llmVerdict] <= strength[preliminaryVerdict] ? llmVerdict : preliminaryVerdict;
}

function formatChunkEvidence(pair) {
  return `${pair.aChunkId}\nA: ${pair.aText}\n\n${pair.bChunkId}\nB: ${pair.bText}`;
}

async function embedTexts(openaiClient, texts, batchSize = 20) {
  const embeddings = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const response = await openaiClient.embeddings.create({
      model: "text-embedding-3-small",
      input: batch,
    });
    embeddings.push(...response.data.map((entry) => entry.embedding));
  }

  return embeddings;
}

async function summarizeWithLlm(openaiClient, payload) {
  const systemPrompt = `You are a strict document alignment analyst.
Only use the evidence pairs supplied in the user message.
Do not infer from any outside knowledge.
If the evidence does not support a claim, say \"Not enough evidence\".
Every reason must cite one or more chunk ids.
Every contradiction must quote exact text from the supplied evidence and cite chunk ids.
Return valid JSON only with this schema:
{
  "verdict": "aligned" | "partial" | "not_aligned" | "insufficient_evidence",
  "reasons": [{ "text": string, "citations": [string] }],
  "contradictions": [{ "aChunkId": string, "bChunkId": string, "aQuote": string, "bQuote": string, "explanation": string }],
  "llm_summary": string
}`;

  const response = await openaiClient.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify(payload, null, 2),
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content);
  return LlmResponseSchema.parse(parsed);
}

function buildFallbackSummary({ verdict, evidencePairs, top, avgTopK, supportedRatio }) {
  if (verdict === "insufficient_evidence") {
    return "Not enough evidence in the selected chunks to make a reliable alignment judgment.";
  }

  const strongest = evidencePairs[0];
  if (!strongest) {
    return "Not enough evidence to compare the selected documents.";
  }

  return `The documents show ${verdict.replace("_", " ")} evidence based on the strongest chunk match (${strongest.aChunkId} ↔ ${strongest.bChunkId}, score ${top.toFixed(3)}). Average top-k similarity is ${avgTopK.toFixed(3)} and supported coverage is ${(supportedRatio * 100).toFixed(1)}%.`;
}

export async function runDocsAlignmentCheck({
  docA,
  docB,
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" }),
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
  maxChunks = DEFAULT_MAX_CHUNKS,
  topK = DEFAULT_TOP_K,
  evidencePairsCount = DEFAULT_EVIDENCE_PAIRS,
} = {}) {
  if (!docA || !docB) {
    throw new Error("Both docA and docB are required.");
  }

  // Check if documents already have text loaded; if not, load them
  const sourceA = docA.text ? docA : await loadDocumentSource(docA);
  const sourceB = docB.text ? docB : await loadDocumentSource(docB);

  if (!sourceA.text || !sourceB.text) {
    throw new Error("Failed to load document text for one or both documents.");
  }

  const warnings = [];
  const aChunksResult = chunkText(sourceA.text, { chunkSize, overlap, maxChunks, sourceLabel: sourceA.id });
  const bChunksResult = chunkText(sourceB.text, { chunkSize, overlap, maxChunks, sourceLabel: sourceB.id });
  warnings.push(...aChunksResult.warnings, ...bChunksResult.warnings);

  if (aChunksResult.chunks.length === 0 || bChunksResult.chunks.length === 0) {
    return {
      verdict: "insufficient_evidence",
      confidence: 0,
      similarity: { top: 0, avgTopK: 0, k: topK },
      evidence: [],
      contradictions: [],
      llm_summary: "Not enough evidence to compare the selected documents.",
      reasons: [
        {
          text: "One or both documents do not contain enough text after chunking.",
          citations: [sourceA.id, sourceB.id],
        },
      ],
      warnings,
      coverage: {
        supportedChunks: 0,
        totalChunks: aChunksResult.chunks.length,
        supportedRatio: 0,
      },
      preliminaryVerdict: "insufficient_evidence",
      docs: {
        a: { id: sourceA.id, originalName: sourceA.originalName },
        b: { id: sourceB.id, originalName: sourceB.originalName },
      },
    };
  }

  const aEmbeddings = await embedTexts(openaiClient, aChunksResult.chunks.map((chunk) => chunk.text));
  const bEmbeddings = await embedTexts(openaiClient, bChunksResult.chunks.map((chunk) => chunk.text));

  const ranking = rankSimilarityPairs(
    aChunksResult.chunks,
    bChunksResult.chunks,
    aEmbeddings,
    bEmbeddings,
    { topK, evidencePairsCount }
  );

  const preliminaryVerdict = derivePreliminaryVerdict(ranking);
  const confidence = Math.max(
    0,
    Math.min(1, 0.2 + ranking.avgTopK * 0.55 + ranking.supportedRatio * 0.25 + ranking.top * 0.15)
  );

  const evidencePairs = ranking.topPairs.map((pair) => ({
    aChunkId: pair.aChunkId,
    bChunkId: pair.bChunkId,
    score: Number(pair.score.toFixed(4)),
    aText: pair.aText,
    bText: pair.bText,
    aDocName: sourceA.originalName,
    bDocName: sourceB.originalName,
    aChunkIndex: pair.aChunkIndex,
    bChunkIndex: pair.bChunkIndex,
  }));

  const llmPayload = {
    documents: {
      a: { id: sourceA.id, originalName: sourceA.originalName },
      b: { id: sourceB.id, originalName: sourceB.originalName },
    },
    metrics: {
      top: ranking.top,
      avgTopK: ranking.avgTopK,
      k: ranking.k,
      supportedRatio: ranking.supportedRatio,
      supportedChunks: ranking.supportedChunks,
      preliminaryVerdict,
    },
    evidence: evidencePairs.map((pair) => ({
      aChunkId: pair.aChunkId,
      bChunkId: pair.bChunkId,
      aDocName: pair.aDocName,
      bDocName: pair.bDocName,
      score: pair.score,
      aText: pair.aText,
      bText: pair.bText,
    })),
  };

  let llmResult;
  try {
    llmResult = await summarizeWithLlm(openaiClient, llmPayload);
  } catch {
    llmResult = {
      verdict: preliminaryVerdict,
      reasons: [
        {
          text: "The evidence supports only a conservative deterministic judgment because the LLM response could not be parsed.",
          citations: evidencePairs.slice(0, 2).map((pair) => pair.aChunkId),
        },
      ],
      contradictions: [],
      llm_summary: buildFallbackSummary({
        verdict: preliminaryVerdict,
        evidencePairs,
        top: ranking.top,
        avgTopK: ranking.avgTopK,
        supportedRatio: ranking.supportedRatio,
      }),
    };
  }

  const finalVerdict = conservativelyMergeVerdicts(preliminaryVerdict, llmResult.verdict);
  const summary =
    llmResult.llm_summary?.trim() ||
    buildFallbackSummary({
      verdict: finalVerdict,
      evidencePairs,
      top: ranking.top,
      avgTopK: ranking.avgTopK,
      supportedRatio: ranking.supportedRatio,
    });

  return {
    verdict: finalVerdict,
    confidence,
    similarity: {
      top: Number(ranking.top.toFixed(4)),
      avgTopK: Number(ranking.avgTopK.toFixed(4)),
      k: ranking.k,
    },
    evidence: evidencePairs,
    contradictions: llmResult.contradictions,
    llm_summary: summary,
    reasons: llmResult.reasons,
    warnings,
    coverage: {
      supportedChunks: ranking.supportedChunks,
      totalChunks: aChunksResult.chunks.length,
      supportedRatio: Number(ranking.supportedRatio.toFixed(4)),
    },
    preliminaryVerdict,
    docs: {
      a: { id: sourceA.id, originalName: sourceA.originalName },
      b: { id: sourceB.id, originalName: sourceB.originalName },
    },
  };
}

export function createDocsAlignmentHandler(deps = {}) {
  const rateLimitMap = deps.rateLimitMap ?? new Map();
  const limitWindowMs = deps.limitWindowMs ?? 60_000;
  const maxRequests = deps.maxRequests ?? 12;
  const openaiClient = deps.openaiClient ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "" });
  const resolveDocument = deps.resolveDocumentById ?? (async (documentId) => {
    const document = await defaultResolveDocumentById(documentId);
    if (!document) return null;
    return loadDocumentSource(document);
  });
  const runDocsAlignmentCheckFn = deps.runDocsAlignmentCheckFn ?? runDocsAlignmentCheck;

  return async function POST(request) {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "anonymous";
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + limitWindowMs });
    } else if (entry.count >= maxRequests) {
      return Response.json({ error: "Rate limit exceeded." }, { status: 429 });
    } else {
      entry.count += 1;
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
    }

    const docAId = body?.docAId;
    const docBId = body?.docBId;

    if (!docAId || !docBId) {
      return Response.json({ error: "docAId and docBId are required." }, { status: 400 });
    }

    if (docAId === docBId) {
      return Response.json(
        {
          verdict: "aligned",
          confidence: 1,
          similarity: { top: 1, avgTopK: 1, k: 3 },
          evidence: [],
          contradictions: [],
          llm_summary: "The same document was selected for both sides, so it is trivially aligned with itself.",
          reasons: [
            { text: "The same document was selected for both Doc A and Doc B.", citations: [docAId, docBId] },
          ],
          warnings: ["The same document was selected for both sides."],
          coverage: { supportedChunks: 0, totalChunks: 0, supportedRatio: 1 },
          preliminaryVerdict: "aligned",
        },
        { status: 200 }
      );
    }

    const docA = await resolveDocument(docAId);
    const docB = await resolveDocument(docBId);

    if (!docA || !docB) {
      return Response.json({ error: "One or both documents were not found." }, { status: 404 });
    }

    try {
      const result = await runDocsAlignmentCheckFn({
        docA,
        docB,
        openaiClient,
        chunkSize: deps.chunkSize,
        overlap: deps.overlap,
        maxChunks: deps.maxChunks,
        topK: deps.topK,
        evidencePairsCount: deps.evidencePairsCount,
      });

      return Response.json(result, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      console.error("[Alignment Error]", message, stack);
      return Response.json({ error: message, details: stack?.split('\n').slice(0, 3).join('\n') }, { status: 500 });
    }
  };
}

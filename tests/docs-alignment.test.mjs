import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, rankSimilarityPairs, createDocsAlignmentHandler } from "../lib/docs-alignment.js";

test("chunkText keeps overlap and stable ids", () => {
  const text = Array.from({ length: 8 }, (_, index) => {
    const line = `Paragraph ${index + 1} ` + "alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(18);
    return line;
  }).join("\n\n");

  const { chunks, warnings } = chunkText(text, {
    chunkSize: 1200,
    overlap: 180,
    maxChunks: 10,
    sourceLabel: "docA",
  });

  assert.ok(chunks.length > 1, "expected multiple chunks");
  assert.equal(chunks[0].id, "docA:chunk:01");
  assert.ok(chunks.every((chunk, index) => chunk.id === `docA:chunk:${String(index + 1).padStart(2, "0")}`));
  assert.ok(chunks[0].text.length <= 1200);
  assert.ok(chunks[1].text.includes("alpha beta gamma"), "expected overlap material to appear in the next chunk");
  assert.equal(warnings.length, 0);
});

test("rankSimilarityPairs orders strongest matches first", () => {
  const aChunks = [{ id: "docA:chunk:01", index: 1, text: "alpha" }];
  const bChunks = [
    { id: "docB:chunk:01", index: 1, text: "alpha" },
    { id: "docB:chunk:02", index: 2, text: "beta" },
  ];
  const aEmbeddings = [[1, 0]];
  const bEmbeddings = [[0.99, 0.01], [0.1, 0.99]];

  const ranking = rankSimilarityPairs(aChunks, bChunks, aEmbeddings, bEmbeddings, {
    topK: 1,
    evidencePairsCount: 1,
  });

  assert.equal(ranking.topPairs.length, 1);
  assert.equal(ranking.topPairs[0].bChunkId, "docB:chunk:01");
  assert.ok(ranking.top > 0.95);
  assert.equal(ranking.perA[0].topMatches[0].bChunkId, "docB:chunk:01");
});

test("alignment handler returns JSON response for selected docs", async () => {
  const documents = new Map([
    ["doc-a", { id: "doc-a", originalName: "Doc A", storedName: "Doc A.md", extension: ".md", size: 1, createdAt: new Date().toISOString(), location: "docs" }],
    ["doc-b", { id: "doc-b", originalName: "Doc B", storedName: "Doc B.md", extension: ".md", size: 1, createdAt: new Date().toISOString(), location: "docs" }],
  ]);

  const handler = createDocsAlignmentHandler({
    resolveDocumentById: async (documentId) => documents.get(documentId) ?? null,
    runDocsAlignmentCheckFn: async ({ docA, docB }) => ({
      verdict: "partial",
      confidence: 0.82,
      similarity: { top: 0.91, avgTopK: 0.84, k: 3 },
      evidence: [
        {
          aChunkId: `${docA.id}:chunk:01`,
          bChunkId: `${docB.id}:chunk:01`,
          score: 0.91,
          aText: "Doc A evidence",
          bText: "Doc B evidence",
          aDocName: docA.originalName,
          bDocName: docB.originalName,
          aChunkIndex: 1,
          bChunkIndex: 1,
        },
      ],
      contradictions: [],
      llm_summary: "Grounded summary based only on provided evidence.",
      reasons: [{ text: "The excerpted policies match at a high level.", citations: [`${docA.id}:chunk:01`, `${docB.id}:chunk:01`] }],
      warnings: [],
      coverage: { supportedChunks: 1, totalChunks: 1, supportedRatio: 1 },
      preliminaryVerdict: "partial",
      docs: {
        a: { id: docA.id, originalName: docA.originalName },
        b: { id: docB.id, originalName: docB.originalName },
      },
    }),
  });

  const request = new Request("http://localhost/api/docs/alignment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docAId: "doc-a", docBId: "doc-b" }),
  });

  const response = await handler(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.verdict, "partial");
  assert.equal(payload.similarity.top, 0.91);
  assert.equal(payload.evidence[0].aChunkId, "doc-a:chunk:01");
  assert.equal(payload.evidence[0].bDocName, "Doc B");
  assert.equal(payload.llm_summary, "Grounded summary based only on provided evidence.");
});

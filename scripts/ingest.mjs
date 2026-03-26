#!/usr/bin/env node
/**
 * Horizon Bank Strategy Bot – Data Ingestion Pipeline
 * Phase 2: Load documents → generate embeddings → upsert into Supabase
 *
 * Usage:
 *   npm install @supabase/supabase-js openai dotenv
 *   node ingest.mjs
 *
 * Environment variables (copy from .env.local):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 */

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import "dotenv/config";

// ─── Clients ────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role bypasses RLS
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Mock Horizon Bank Knowledge Base ───────────────────────────────────────
// Replace with real document loading (PDF, DOCX, etc.) in production.
// Each entry maps to one or more vector chunks.

const HORIZON_BANK_DOCUMENTS = [
  // ── Digital Transformation ───────────────────────────────────────────────
  {
    content: `Horizon Bank Digital Transformation Strategy 2024-2027:
Horizon Bank targets a full cloud-native migration of its core banking platform by Q4 2025.
The architecture adopts a microservices pattern built on AWS with Kubernetes orchestration.
APIs are exposed via an internal developer portal (Kong Gateway) to enable composable banking.
Legacy COBOL mainframe workloads are being containerised using AWS Blu Age before migration.
Target state: 90% of transaction processing on cloud-native systems by end of 2026.`,
    metadata: { domain: "Digital Transformation", source: "Strategy 2024-2027", tags: ["cloud", "microservices", "migration"] },
  },
  {
    content: `Horizon Bank Mobile Banking Roadmap:
Current mobile app (iOS/Android) has a 3.8/5 App Store rating and 2.1M monthly active users.
Target for 2025: biometric-first authentication (FIDO2), personalised AI nudges, and
real-time payment notifications. A super-app strategy consolidates investments, lending,
and insurance into one shell application. Tech stack: React Native + GraphQL BFF.
Feature velocity KPI: 2 releases per sprint (bi-weekly cadence).`,
    metadata: { domain: "Digital Transformation", source: "Mobile Roadmap 2025", tags: ["mobile", "app", "biometric"] },
  },

  // ── Risk & Compliance ────────────────────────────────────────────────────
  {
    content: `Horizon Bank Enterprise Risk Framework (ERF) v3.1:
Risk appetite is formally governed by the Board Risk Committee (BRC) meeting quarterly.
Three lines of defence model: (1) Business units own and manage risk; (2) Risk & Compliance
provides oversight; (3) Internal Audit provides independent assurance.
Key risk indicators (KRIs) are tracked in a proprietary GRC platform (ServiceNow IRM).
Operational risk losses in 2023 totalled CZK 42M, below the CZK 80M risk appetite ceiling.`,
    metadata: { domain: "Risk & Compliance", source: "ERF v3.1", tags: ["risk", "governance", "BRC"] },
  },
  {
    content: `Horizon Bank Regulatory Compliance Posture – EU Landscape:
Horizon Bank complies with DORA (Digital Operational Resilience Act) effective Jan 2025.
ICT third-party risk register covers 210 critical vendors. Annual penetration testing
is mandated for all internet-facing systems. GDPR DPA reports are filed with the Czech ÚOOÚ.
Basel IV capital requirements are being absorbed with a CET1 ratio of 14.2% as of Q3 2024.
PSD2 Strong Customer Authentication (SCA) is enforced on all transactions above €30.`,
    metadata: { domain: "Risk & Compliance", source: "Regulatory Report Q3 2024", tags: ["DORA", "GDPR", "Basel IV", "PSD2"] },
  },

  // ── Data & AI Strategy ───────────────────────────────────────────────────
  {
    content: `Horizon Bank Data Strategy 2024:
A unified data mesh architecture is being adopted. Domain teams own their data products
and publish them to a central data marketplace (built on Databricks Unity Catalog).
Real-time streaming pipelines use Apache Kafka with schema registry (Confluent Cloud).
Master Data Management (MDM) for customer entities is handled by Informatica MDM.
Data quality SLAs: >98% completeness and >99.5% accuracy for Tier-1 customer data.`,
    metadata: { domain: "Data & AI", source: "Data Strategy 2024", tags: ["data mesh", "kafka", "Databricks"] },
  },
  {
    content: `Horizon Bank AI/ML Adoption Strategy:
Current production ML models: credit scoring (XGBoost, Gini 0.74), fraud detection
(gradient boosting ensemble, F1 0.91), and customer churn prediction (LightGBM).
MLOps platform: MLflow on Databricks with automated retraining triggers based on
data drift thresholds (PSI > 0.25). Model governance requires approval from the
AI Ethics Committee before production deployment. Target: 15 new AI use cases by 2026.`,
    metadata: { domain: "Data & AI", source: "AI Adoption Strategy", tags: ["ML", "MLOps", "fraud", "credit scoring"] },
  },

  // ── Customer Experience ───────────────────────────────────────────────────
  {
    content: `Horizon Bank Customer Experience (CX) Transformation:
Net Promoter Score (NPS) is 42 as of Q3 2024 (industry benchmark: 38).
Target NPS of 55 by 2026 driven by hyper-personalisation and omni-channel consistency.
CX stack: Salesforce CRM + Salesforce Marketing Cloud + custom CDP (Customer Data Platform).
Customer 360 view integrates transaction history, service interactions, and product holdings.
Self-service resolution rate target: 80% by end of 2025 (currently 61%).`,
    metadata: { domain: "Customer Experience", source: "CX Transformation Plan", tags: ["NPS", "CRM", "CDP", "personalisation"] },
  },
  {
    content: `Horizon Bank Branch Network Optimisation:
Branch count reduced from 180 to 140 between 2020-2024 as digital adoption rose to 78%.
Remaining branches are being converted to advice-led hubs (no cash handling).
Video banking kiosks will be deployed in 30 high-footfall locations by Q2 2025.
Branch staff are being reskilled as financial advisors (minimum Cert IV Finance qualification).
Target: 15% reduction in branch operating costs while maintaining customer satisfaction.`,
    metadata: { domain: "Customer Experience", source: "Branch Optimisation Strategy", tags: ["branch", "digital", "reskilling"] },
  },

  // ── Technology Architecture ───────────────────────────────────────────────
  {
    content: `Horizon Bank Target Architecture Blueprint:
Core banking system: migration from Temenos T24 (on-prem) to Thought Machine Vault (SaaS).
Integration layer: event-driven architecture using Apache Kafka + AsyncAPI contracts.
Security: Zero Trust Architecture (ZTA) with Zscaler ZTNA replacing legacy VPN.
Observability stack: OpenTelemetry → Grafana + Tempo + Loki. SLO target: 99.95% availability.
Infrastructure-as-Code: Terraform with Atlantis for PR-based plan/apply workflows.`,
    metadata: { domain: "Technology", source: "Target Architecture Blueprint", tags: ["Vault", "Kafka", "ZTA", "Terraform"] },
  },
  {
    content: `Horizon Bank API Strategy:
API-first mandate adopted in 2023. All new capabilities must be API-exposed before UI.
Internal APIs: REST + OpenAPI 3.1 specs stored in Backstage developer portal.
Partner APIs: GraphQL federation gateway exposing account, payment, and product APIs.
Open Banking compliance: CMA9-equivalent API standards adopted voluntarily.
API versioning policy: minimum 12-month deprecation notice; sunset header enforced by Kong.`,
    metadata: { domain: "Technology", source: "API Strategy 2023", tags: ["API", "GraphQL", "OpenAPI", "Open Banking"] },
  },

  // ── Sustainability ────────────────────────────────────────────────────────
  {
    content: `Horizon Bank ESG and Sustainability Strategy:
Net-zero commitment for Scope 1 and 2 emissions by 2030; Scope 3 by 2040.
Green finance portfolio target: CZK 15B in sustainable loans/bonds by 2027.
Data centre PUE (Power Usage Effectiveness) target: <1.3 (currently 1.51).
ESG data reporting follows GRI Standards and TCFD recommendations.
Internal carbon price set at €45/tonne CO2e for investment decision-making.`,
    metadata: { domain: "Sustainability", source: "ESG Strategy 2024", tags: ["ESG", "net-zero", "green finance", "TCFD"] },
  },

  // ── Human Capital ─────────────────────────────────────────────────────────
  {
    content: `Horizon Bank Workforce & Talent Strategy:
Total headcount: 4,200 FTE as of 2024. Target: 3,800 FTE by 2027 through attrition and automation.
Digital talent gap: 320 open technology roles (cloud engineers, data scientists, security).
Partnerships with CTU Prague and Masaryk University for graduate talent pipeline.
Internal reskilling: 1,200 employees enrolled in Digital Academy (Python, cloud, data literacy).
Employee NPS (eNPS): 34. Target: 45 by 2025 via hybrid work policy and L&D investment.`,
    metadata: { domain: "Human Capital", source: "Talent Strategy 2024", tags: ["workforce", "reskilling", "talent", "eNPS"] },
  },
];

// ─── Chunking ────────────────────────────────────────────────────────────────
// For production, implement sliding-window chunking with overlap.
// Here each document is already a single semantic chunk.

function chunkDocument(doc, maxChunkChars = 800) {
  const { content, metadata } = doc;
  const chunks = [];
  // Simple paragraph-based chunking
  const paragraphs = content.split("\n").filter((p) => p.trim().length > 0);
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n" + para).length > maxChunkChars && current.length > 0) {
      chunks.push({ content: current.trim(), metadata });
      current = para;
    } else {
      current = current ? current + "\n" + para : para;
    }
  }
  if (current.trim()) chunks.push({ content: current.trim(), metadata });
  return chunks;
}

// ─── Embedding Generation (batched) ─────────────────────────────────────────
const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20; // OpenAI recommends ≤2048 per request; 20 chunks is safe

async function generateEmbeddings(texts) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  // Response.data is ordered identically to input
  return response.data.map((item) => item.embedding);
}

// ─── Upsert into Supabase ────────────────────────────────────────────────────

async function upsertChunks(chunks) {
  const { error } = await supabase.from("documents").insert(
    chunks.map((c) => ({
      content: c.content,
      embedding: c.embedding,
      metadata: c.metadata,
    }))
  );
  if (error) throw new Error(`Supabase insert error: ${error.message}`);
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function ingest() {
  console.log("🏦  Horizon Bank RAG – Ingestion Pipeline starting…\n");

  // 1. Flatten documents into chunks
  const allChunks = HORIZON_BANK_DOCUMENTS.flatMap((doc) =>
    chunkDocument(doc)
  );
  console.log(`📄  Total chunks to ingest: ${allChunks.length}`);

  // 2. Process in batches
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allChunks.length / BATCH_SIZE);

    console.log(`\n⚙️   Batch ${batchIndex}/${totalBatches} – embedding ${batch.length} chunks…`);

    try {
      // 3. Generate embeddings for this batch
      const texts = batch.map((c) => c.content);
      const embeddings = await generateEmbeddings(texts);

      // 4. Attach embeddings to chunks
      const chunksWithEmbeddings = batch.map((chunk, idx) => ({
        ...chunk,
        embedding: embeddings[idx],
      }));

      // 5. Upsert into Supabase
      await upsertChunks(chunksWithEmbeddings);
      console.log(`✅  Batch ${batchIndex} upserted successfully.`);
    } catch (err) {
      console.error(`❌  Batch ${batchIndex} failed: ${err.message}`);
      // In production: implement exponential backoff + dead-letter queue
      throw err;
    }

    // Throttle to stay within OpenAI rate limits (3 RPM on free tier, 500 RPM on tier 1)
    if (i + BATCH_SIZE < allChunks.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log("\n🎉  Ingestion complete. All chunks embedded and stored in Supabase.");
}

ingest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

# Horizon Bank Strategy Bot – Complete Deployment Guide
# Phase 5: Deployment & Technical Reference

==============================================================
SECTION 1: LOCAL DEVELOPMENT SETUP
==============================================================

1. Clone and install
   git clone https://github.com/your-org/horizon-bank-strategy-bot.git
   cd horizon-bank-strategy-bot
   npm install

2. Environment setup
   cp .env.local.example .env.local
   # Edit .env.local with your actual keys

3. Database setup (Supabase SQL Editor)
   - Open: https://supabase.com/dashboard → your project → SQL Editor
   - Paste and run: supabase/schema.sql
   - Verify: SELECT * FROM documents LIMIT 1; (should return empty)

4. Ingest documents
   npm run ingest
   # Expected output: 🎉 Ingestion complete. All chunks embedded and stored.

5. Run development server
   npm run dev
   # App available at: http://localhost:3000

==============================================================
SECTION 2: SUPABASE CONFIGURATION
==============================================================

Required Supabase settings:
  - Project region: eu-central-1 (Frankfurt) for GDPR compliance
  - pgvector version: >=0.5.0 (confirm in Extensions tab)
  - Database plan: Pro or higher for production (connection pooler required)

Verify RPC function:
  SELECT match_documents(
    '[0.1, 0.2, ...]'::vector(1536),  -- replace with real embedding
    0.70,
    5
  );

Connection pooling (Supavisor):
  - Use the POOLER connection string (port 6543) for serverless/edge
  - The direct connection (port 5432) is for the ingestion script only

==============================================================
SECTION 3: VERCEL DEPLOYMENT
==============================================================

Step 1: Push to GitHub
  git add .
  git commit -m "feat: initial horizon bank strategy bot"
  git push origin main

Step 2: Import to Vercel
  - Navigate to: https://vercel.com/new
  - Import GitHub repository: horizon-bank-strategy-bot
  - Framework preset: Next.js (auto-detected)
  - Root directory: . (project root)

Step 3: Configure Environment Variables in Vercel
  Go to: Vercel Dashboard → Project → Settings → Environment Variables
  Add the following (set for Production + Preview + Development):

  OPENAI_API_KEY                = sk-proj-...
  SUPABASE_URL                  = https://xxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY     = eyJ...
  NEXT_PUBLIC_SUPABASE_ANON_KEY = eyJ...

  ⚠ NEVER expose SUPABASE_SERVICE_ROLE_KEY to the client.
    It is only used server-side in the API route.

Step 4: Deploy
  - Click "Deploy"
  - Vercel builds Next.js and deploys to edge network automatically
  - Build time: ~45-90 seconds

Step 5: Verify deployment
  - POST to https://your-app.vercel.app/api/chat with:
    {
      "messages": [{"role": "user", "content": "What is the cloud migration target?"}],
      "mode": "chat"
    }
  - Expect: streaming response with markdown table

==============================================================
SECTION 4: DEPLOYMENT CHECKLIST
==============================================================

Pre-deployment:
  [ ] pgvector extension enabled in Supabase
  [ ] schema.sql executed successfully
  [ ] RPC function match_documents created and tested
  [ ] Ingestion script run (npm run ingest)
  [ ] Documents table contains rows (SELECT COUNT(*) FROM documents;)
  [ ] .env.local.example committed (NOT .env.local)
  [ ] .gitignore includes .env.local

Vercel:
  [ ] All 4 environment variables set
  [ ] Edge runtime confirmed (runtime = "edge" in route.ts)
  [ ] Build succeeds (no TypeScript errors)
  [ ] /api/chat endpoint returns 200 for test POST
  [ ] Streaming confirmed (response arrives incrementally)

Production hardening:
  [ ] Vercel Rate Limiting configured (Middleware)
  [ ] Supabase RLS reviewed
  [ ] OpenAI usage limits set (platform.openai.com → Usage limits)
  [ ] Sentry or Vercel Analytics error monitoring enabled
  [ ] Custom domain configured with HTTPS

==============================================================
SECTION 5: NEXT.JS CONFIG
==============================================================

File: next.config.mjs

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for react-markdown with remark-gfm
  transpilePackages: [],
  // Security headers
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // Restrict to internal use only in production
          // { key: "Access-Control-Allow-Origin", value: "https://internal.horizonbank.cz" },
        ],
      },
    ];
  },
};

export default nextConfig;

==============================================================
SECTION 6: RATE LIMITING MIDDLEWARE (production)
==============================================================

File: middleware.ts (place in project root)

import { NextRequest, NextResponse } from "next/server";

// Simple in-memory rate limiter for the API route
// Replace with Vercel KV or Upstash Redis for distributed rate limiting
const rateLimitMap = new Map<string, { count: number; reset: number }>();

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname === "/api/chat") {
    const ip = req.ip ?? "anonymous";
    const now = Date.now();
    const windowMs = 60_000; // 1 minute
    const maxRequests = 20;

    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.reset) {
      rateLimitMap.set(ip, { count: 1, reset: now + windowMs });
    } else if (entry.count >= maxRequests) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please wait 60 seconds." },
        { status: 429 }
      );
    } else {
      entry.count++;
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};

==============================================================
SECTION 7: MONITORING & OBSERVABILITY
==============================================================

Recommended stack:
  - Vercel Analytics: page performance + real user monitoring
  - Vercel Log Drains: route logs to Datadog/Grafana
  - OpenAI Usage Dashboard: token spend monitoring
  - Supabase Dashboard: query latency, connection pool utilisation

Key metrics to track:
  - p95 embedding latency (target: <200ms)
  - p95 LLM response latency (target: <3s to first token)
  - match_documents RPC execution time (target: <50ms)
  - Retrieved chunk count per query (watch for systematic 0-chunk responses)
  - Similarity score distribution (monitor for query drift)
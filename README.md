# Horizon Bank Strategy Bot

An internal RAG (Retrieval-Augmented Generation) chatbot that answers questions about Horizon Bank's strategy, KPIs, and architecture by retrieving relevant content from a Supabase vector database and streaming responses from OpenAI GPT-4o.

## Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project with pgvector enabled
- An [OpenAI](https://platform.openai.com) API key

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env.local` file in the project root (never commit this file):

```env
# OpenAI — https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-proj-...

# Supabase — Dashboard → Settings → API
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...     # service_role secret (NOT the publishable/anon key)
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...  # anon public key
```

> ⚠ **`SUPABASE_SERVICE_ROLE_KEY` must be the `service_role` secret key** from  
> Supabase Dashboard → Settings → API → "service_role" (not the "anon" or "publishable" key).  
> This key bypasses Row Level Security and is only used server-side.

### 3. Set up the Supabase database

Open the [Supabase SQL Editor](https://supabase.com/dashboard) for your project and run the contents of `supabase/schema.sql`. This creates:

- The `documents` table with `content TEXT`, `embedding VECTOR(1536)`, and `metadata JSONB` columns
- An HNSW index for fast vector search
- The `match_documents` RPC function used by the API
- RLS policies that allow the service-role key full access

Verify the setup:

```sql
-- Should return 0 rows (empty table)
SELECT COUNT(*) FROM documents;

-- Should return a row describing the function
SELECT proname FROM pg_proc WHERE proname = 'match_documents';
```

### 4. Ingest documents (populate embeddings)

```bash
npm run ingest
```

By default, this script now ingests from both runtime sources:

- `./docs`
- `./data/uploads`

You can still ingest a custom folder only:

```bash
npm run ingest -- ./my-folder
```

The script embeds all documents using OpenAI `text-embedding-3-small` and stores them in the `documents` table. Expected output:

```
✅ Ingestion complete. All chunks embedded and stored.
```

Verify the data was inserted:

```sql
SELECT id, metadata->>'domain' AS domain, LEFT(content, 60) AS preview
FROM documents
LIMIT 5;
```

> **Common issue:** If you manually inserted rows into the `documents` table without running `npm run ingest`, the `embedding` column will be NULL. Rows with NULL embeddings are invisible to vector search and will always produce "Insufficient data" responses. Re-run `npm run ingest` to fix this.

### 5. Run the development server

```bash
npm run dev
```

The app is available at [http://localhost:3000](http://localhost:3000).

### 6. Upload and ingest from UI

1. Open the app and switch to **Documents** mode.
2. Upload files (`.pdf`, `.docx`, `.txt`, `.md`, `.csv`).
3. Click **Run Ingest** to generate embeddings and write chunks to Supabase.

API endpoints used by the UI:

- `GET /api/upload` – list files from `docs` and `data/uploads`
- `POST /api/upload` – upload files into `data/uploads`
- `POST /api/ingest` – run ingest pipeline from both folders

---

## Validate the RAG pipeline

### Option A – Probe script (recommended first check)

```bash
node scripts/probe-rpc.mjs "nps target"
```

Expected output when everything is working:

```
[probe] query="nps target"
[probe] documents.total_rows=28
[probe] documents.null_embeddings=0
[probe] embedding generated (1536-dim)
[probe] threshold=0.50 rows=3 top_similarity=0.8521 domain=KPI
[probe] ✅ Query "nps target" matched 3 chunk(s) at threshold=0.5
```

### Option B – Health endpoint

While the app is running, open [http://localhost:3000/api/health](http://localhost:3000/api/health) in your browser. A healthy system returns:

```json
{
  "status": "ok",
  "checks": {
    "env": { "ok": true, "supabase_url": "set ✓", "supabase_key": "service_role ✓", "openai_key": "set ✓" },
    "documents_table": { "ok": true, "rows": 28, "rows_with_embedding": 28, "rows_missing_embedding": 0 },
    "rpc_match_documents": { "ok": true }
  }
}
```

### Option C – Chat API (curl)

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What is the NPS target?"}],"mode":"chat"}'
```

You should receive a streaming response containing a markdown table with NPS data.

---

## Troubleshooting

### "Insufficient data to generate a response"

This message appears when the RAG pipeline retrieves 0 document chunks. Work through this checklist:

| Check | Command / URL |
|-------|--------------|
| Health diagnostic | `GET /api/health` |
| Table has rows | `SELECT COUNT(*) FROM documents;` in Supabase SQL Editor |
| Embeddings are populated | `SELECT COUNT(*) FROM documents WHERE embedding IS NULL;` (should be 0) |
| RPC function exists | `SELECT proname FROM pg_proc WHERE proname = 'match_documents';` |
| Probe the full pipeline | `node scripts/probe-rpc.mjs "nps target"` |

**Most common causes:**

1. **`npm run ingest` was never run** – the table is empty.
2. **Rows inserted manually without embeddings** – the `embedding` column is NULL. Re-run `npm run ingest`.
3. **Wrong Supabase key** – using the `anon` key instead of `service_role` key in `SUPABASE_SERVICE_ROLE_KEY`.
4. **`match_documents` RPC not created** – run `supabase/schema.sql` in the Supabase SQL Editor.
5. **pgvector not enabled** – enable it in Supabase Dashboard → Database → Extensions → search "vector".

### RPC error: function match_documents does not exist

Run `supabase/schema.sql` in the Supabase SQL Editor to create the function.

### Environment variable not found at runtime

In Next.js, server-side env vars (without `NEXT_PUBLIC_` prefix) must be in `.env.local`. The file must be in the project root, not a subdirectory.

---

## Project structure

```
horizonai_strategy_bot/
├── app/
│   ├── api/
│   │   ├── chat/route.ts      # RAG pipeline: embed → retrieve → stream
│   │   ├── health/route.ts    # Diagnostic endpoint
│   │   ├── upload/route.ts    # Upload + list runtime docs
│   │   └── ingest/route.ts    # Trigger ingest from docs + uploads
│   ├── layout.tsx
│   └── page.tsx               # Chat UI
├── data/
│   └── uploads/               # Runtime user uploads (gitignored)
├── scripts/
│   ├── ingest.mjs             # Embed and store documents in Supabase
│   └── probe-rpc.mjs          # Test the full RAG retrieval pipeline
├── supabase/
│   └── schema.sql             # pgvector table + match_documents RPC + RLS
├── deployment.md              # Full deployment reference (Vercel + Supabase)
└── .env.local                 # ← create this (never commit)
```

---

## Modes

| Mode | Description |
|------|-------------|
| **Query Mode** | Ask questions about Horizon Bank strategy, KPIs, architecture |
| **Gap Analysis** | Paste external strategy text; the bot compares it against internal Horizon Bank documents |

---

## Tech stack

- **Next.js 15** (App Router, Edge Runtime)
- **Vercel AI SDK** (`ai`, `@ai-sdk/openai`, `@ai-sdk/react`) for streaming
- **OpenAI** `gpt-4o` for responses, `text-embedding-3-small` for embeddings
- **Supabase** with `pgvector` for vector search via `match_documents` RPC
- **React Markdown** + `remark-gfm` for rendering table responses

"use client";
/**
 * Horizon Bank Strategy Bot – Main Chat UI (Redesigned)
 * Modern chat interface similar to ChatGPT/Claude/Gemini
 */

import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

type Mode = "chat" | "documents";

type ManagedDocument = {
  id: string;
  originalName: string;
  storedName: string;
  extension: string;
  size: number;
  createdAt: string;
  location: "uploads" | "docs";
};

type AlignmentVerdict = "aligned" | "partial" | "not_aligned" | "insufficient_evidence";

type AlignmentEvidence = {
  aChunkId: string;
  bChunkId: string;
  score: number;
  aText: string;
  bText: string;
  aDocName?: string;
  bDocName?: string;
  aChunkIndex?: number;
  bChunkIndex?: number;
};

type AlignmentResult = {
  verdict: AlignmentVerdict;
  confidence: number;
  similarity: { top: number; avgTopK: number; k: number };
  evidence: AlignmentEvidence[];
  contradictions: Array<{
    aChunkId: string;
    bChunkId: string;
    aQuote: string;
    bQuote: string;
    explanation: string;
  }>;
  llm_summary: string;
  reasons?: Array<{ text: string; citations: string[] }>;
  warnings?: string[];
  coverage?: { supportedChunks: number; totalChunks: number; supportedRatio: number };
  preliminaryVerdict?: AlignmentVerdict;
  docs?: {
    a: { id: string; originalName: string };
    b: { id: string; originalName: string };
  };
};

function matchesDocQuery(doc: ManagedDocument, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [doc.originalName, doc.storedName, doc.location, doc.extension]
    .filter(Boolean)
    .some((value) => value.toLowerCase().includes(normalizedQuery));
}

function formatAlignmentVerdict(verdict: AlignmentVerdict): string {
  switch (verdict) {
    case "aligned":
      return "Aligned";
    case "partial":
      return "Partially aligned";
    case "not_aligned":
      return "Not aligned";
    case "insufficient_evidence":
    default:
      return "Not enough evidence";
  }
}

function getDocIcon(extension: string): string {
  if (extension === ".pdf") return "PDF";
  if (extension === ".docx") return "DOC";
  if (extension === ".csv") return "CSV";
  if (extension === ".md") return "MD";
  return "TXT";
}

// ─── Dashboard Types ──────────────────────────────────────────────────────────

type ChartType = "bar" | "line" | "pie" | "table";

type ChartSpec = {
  title: string;
  type: ChartType;
  sql: string;
};

type ChartResult = {
  title: string;
  type: string;
  data?: Record<string, unknown>[];
  error?: string;
};

// ─── Chart palette ────────────────────────────────────────────────────────────

const CHART_COLORS = ["#4F8CFF", "#22C55E", "#EAB308", "#A855F7", "#EF4444", "#06B6D4", "#F97316"];

// ─── DashboardBlock ───────────────────────────────────────────────────────────

function DashboardBlock({ specs }: { specs: ChartSpec[] }) {
  const [charts, setCharts] = useState<ChartResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable key derived from the spec content so we only re-fetch when specs change
  const specsKey = JSON.stringify(specs);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/dashboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ charts: specs }),
        });
        const json = await res.json();
        if (!cancelled) {
          setCharts(Array.isArray(json.charts) ? json.charts : []);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Dashboard failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  // specsKey is a stable primitive derived from specs; it correctly tracks changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specsKey]);

  if (loading) {
    return (
      <div className="dashboard-loading">
        <span className="typing-indicator" style={{ display: "inline-flex", gap: 4 }}>
          <span /><span /><span />
        </span>
        <span style={{ marginLeft: 8, color: "var(--text-secondary)", fontSize: "0.875rem" }}>Building dashboard…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-banner" style={{ marginTop: "0.75rem" }}>⚠ {error}</div>
    );
  }

  if (!charts) return null;

  return (
    <div className="dashboard-grid">
      {charts.map((chart, idx) => (
        <div key={idx} className="dashboard-card">
          <p className="dashboard-card-title">{chart.title}</p>
          {chart.error ? (
            <p className="dashboard-card-error">⚠ {chart.error}</p>
          ) : (
            <ChartRenderer chart={chart} colorIndex={idx} />
          )}
        </div>
      ))}
    </div>
  );
}

function ChartRenderer({ chart, colorIndex }: { chart: ChartResult; colorIndex: number }) {
  const rows = chart.data ?? [];
  if (rows.length === 0) {
    return <p className="dashboard-card-empty">No data returned.</p>;
  }

  const color = CHART_COLORS[colorIndex % CHART_COLORS.length];
  const keys = Object.keys(rows[0]);
  const xKey = keys[0];
  const yKey = keys[1] ?? keys[0];

  // Normalise values to numbers for numeric charts
  const numericData = rows.map((r) => ({
    ...r,
    [yKey]: Number(r[yKey]) || 0,
  }));

  if (chart.type === "bar") {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={numericData} margin={{ top: 8, right: 16, left: 0, bottom: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
          <XAxis dataKey={xKey} tick={{ fill: "#9CA3AF", fontSize: 11 }} angle={-30} textAnchor="end" />
          <YAxis tick={{ fill: "#9CA3AF", fontSize: 11 }} />
          <Tooltip contentStyle={{ background: "#1F2937", border: "none", borderRadius: 8 }} />
          <Bar dataKey={yKey} fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chart.type === "line") {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={numericData} margin={{ top: 8, right: 16, left: 0, bottom: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" />
          <XAxis dataKey={xKey} tick={{ fill: "#9CA3AF", fontSize: 11 }} angle={-30} textAnchor="end" />
          <YAxis tick={{ fill: "#9CA3AF", fontSize: 11 }} />
          <Tooltip contentStyle={{ background: "#1F2937", border: "none", borderRadius: 8 }} />
          <Line type="monotone" dataKey={yKey} stroke={color} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (chart.type === "pie") {
    const pieData = rows.map((r) => ({
      name: String(r[xKey] ?? ""),
      value: Number(r[yKey]) || 0,
    }));
    return (
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
            {pieData.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={{ background: "#1F2937", border: "none", borderRadius: 8 }} />
          <Legend wrapperStyle={{ color: "#9CA3AF", fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  // Fallback: table
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k} style={{ background: "var(--surface)", padding: "0.5rem 0.75rem", textAlign: "left", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((row, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k} style={{ padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)", color: "var(--text-primary)" }}>{String(row[k] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Message content renderer ─────────────────────────────────────────────────

/**
 * Renders an assistant message, replacing <dashboard>[...]</dashboard> tags
 * with the interactive DashboardBlock component.
 */
function MessageContent({ text }: { text: string }) {
  const DASHBOARD_RE = /<dashboard>(\[[\s\S]*?])<\/dashboard>/;
  const match = DASHBOARD_RE.exec(text);

  if (!match) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    );
  }

  const before = text.slice(0, match.index).trim();
  const after = text.slice(match.index + match[0].length).trim();

  let specs: ChartSpec[] = [];
  try {
    specs = JSON.parse(match[1]) as ChartSpec[];
  } catch {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    );
  }

  return (
    <>
      {before && (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{before}</ReactMarkdown>
      )}
      <DashboardBlock specs={specs} />
      {after && (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{after}</ReactMarkdown>
      )}
    </>
  );
}

export default function HorizonBotPage() {
  const [mode, setMode] = useState<Mode>("chat");
  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [docsFiles, setDocsFiles] = useState<ManagedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [docsNotice, setDocsNotice] = useState<string | null>(null);
  const [ingestLogs, setIngestLogs] = useState<string[]>([]);
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const [alignmentQueryA, setAlignmentQueryA] = useState("");
  const [alignmentQueryB, setAlignmentQueryB] = useState("");
  const [alignmentDocAId, setAlignmentDocAId] = useState("");
  const [alignmentDocBId, setAlignmentDocBId] = useState("");
  const [alignmentLoading, setAlignmentLoading] = useState(false);
  const [alignmentResult, setAlignmentResult] = useState<AlignmentResult | null>(null);
  const [alignmentError, setAlignmentError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { messages, sendMessage, status, error } = useChat();
  const isLoading = status === "submitted" || status === "streaming";

  function getMessageText(
    msg: { parts?: Array<{ type?: string; text?: string }> }
  ): string {
    if (!msg.parts || msg.parts.length === 0) return "";
    return msg.parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
  }

  /** Detect whether the user's message is requesting a dashboard. */
  function isDashboardRequest(text: string): boolean {
    return /\b(dashboard|chart|graph|visuali[sz]e|plot|visual)\b/i.test(text);
  }

  async function handleFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode === "documents") return;

    const text = input.trim();
    if (!text || isLoading) return;

    const chatMode = isDashboardRequest(text) ? "dashboard" : "chat";
    await sendMessage({ text }, { body: { mode: chatMode } });
    setInput("");
  }

  async function handleSyncDatabricks() {
    if (syncing) return;
    setSyncing(true);
    setDocsNotice(null);
    try {
      const res = await fetch("/api/sync-databricks", { method: "POST" });
      const payload = await parseApiResponse(res);
      if (!res.ok && res.status !== 207)
        throw new Error(String(payload?.error ?? "Sync failed."));
      const results = Array.isArray(payload.results) ? payload.results : [];
      const totalRows = results.reduce(
        (sum: number, r: { rows?: number }) => sum + (r.rows ?? 0),
        0
      );
      setDocsNotice(`Databricks sync complete. ${totalRows} rows upserted.`);
    } catch (err) {
      setDocsNotice(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  async function refreshDocuments() {
    const res = await fetch("/api/upload", { method: "GET" });
    if (!res.ok) throw new Error("Failed to fetch documents list.");

    const data = await res.json();
    const uploads: ManagedDocument[] = Array.isArray(data.uploads) ? data.uploads : [];
    const docs: ManagedDocument[] = Array.isArray(data.docs) ? data.docs : [];
    setDocsFiles([...uploads, ...docs]);
  }

  async function parseApiResponse(res: Response) {
    const raw = await res.text();
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const startsWithHtml = raw.trimStart().startsWith("<!DOCTYPE") || raw.trimStart().startsWith("<html");
      const fallback = startsWithHtml
        ? `Server returned HTML error page (status ${res.status}). Check server logs.`
        : `Invalid API response (status ${res.status}).`;
      throw new Error(fallback);
    }
  }

  async function handleUploadSubmit() {
    if (pendingFiles.length === 0 || uploading) return;
    setDocsNotice(null);
    setUploading(true);

    try {
      const formData = new FormData();
      for (const file of pendingFiles) formData.append("files", file);

      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const payload = await parseApiResponse(res);
      if (!res.ok) throw new Error(String(payload?.error ?? "Upload failed."));

      const savedCount = Array.isArray(payload.saved) ? payload.saved.length : 0;
      const rejectedCount = Array.isArray(payload.rejected) ? payload.rejected.length : 0;
      setDocsNotice(`Upload complete: saved ${savedCount}, rejected ${rejectedCount}.`);
      setPendingFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await refreshDocuments();
    } catch (err) {
      setDocsNotice(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleIngestSubmit() {
    if (ingesting) return;
    setIngesting(true);
    setDocsNotice(null);
    setIngestLogs([]);

    try {
      const res = await fetch("/api/ingest", { method: "POST" });
      const payload = await parseApiResponse(res);
      if (!res.ok || payload?.ok === false) throw new Error(String(payload?.error ?? "Ingest failed."));

      const logs = Array.isArray(payload.logs) ? payload.logs : [];
      setIngestLogs(logs);
      setDocsNotice(`Ingest complete: files ${payload.filesProcessed ?? 0}, chunks ${payload.chunksInserted ?? 0}.`);
    } catch (err) {
      setDocsNotice(err instanceof Error ? err.message : "Ingest failed.");
    } finally {
      setIngesting(false);
    }
  }

  async function handleDeleteUpload(storedName: string) {
    try {
      setDocsNotice(null);
      const res = await fetch("/api/upload", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storedName }),
      });
      const payload = await parseApiResponse(res);
      if (!res.ok) throw new Error(String(payload?.error ?? "Delete failed."));

      setDocsNotice("Upload deleted.");
      await refreshDocuments();
    } catch (err) {
      setDocsNotice(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  async function handleRunAlignmentCheck() {
    if (!alignmentDocAId || !alignmentDocBId || alignmentDocAId === alignmentDocBId || alignmentLoading) return;

    setAlignmentLoading(true);
    setAlignmentError(null);
    setAlignmentResult(null);

    try {
      const res = await fetch("/api/docs/alignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docAId: alignmentDocAId, docBId: alignmentDocBId }),
      });
      const payload = await parseApiResponse(res);
      if (!res.ok) throw new Error(String(payload?.error ?? "Alignment check failed."));

      setAlignmentResult(payload as AlignmentResult);
    } catch (err) {
      setAlignmentError(err instanceof Error ? err.message : "Alignment check failed.");
    } finally {
      setAlignmentLoading(false);
    }
  }

  function openAlignmentModal() {
    if (docsFiles.length >= 2) {
      setAlignmentDocAId((current) => current || docsFiles[0].id);
      setAlignmentDocBId((current) => current || docsFiles[1]?.id || docsFiles[0].id);
    }
    setAlignmentError(null);
    setAlignmentResult(null);
    setAlignmentOpen(true);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    refreshDocuments().catch(() => setDocsNotice("Unable to load document inventory."));
  }, []);

  useEffect(() => {
    if (!alignmentOpen || docsFiles.length === 0) return;

    const firstDoc = docsFiles[0];
    const secondDoc = docsFiles[1] ?? docsFiles[0];

    setAlignmentDocAId((current) => (docsFiles.some((doc) => doc.id === current) ? current : firstDoc.id));
    setAlignmentDocBId((current) => {
      const currentIsValid = docsFiles.some((doc) => doc.id === current && doc.id !== alignmentDocAId);
      if (currentIsValid) return current;
      return docsFiles.find((doc) => doc.id !== alignmentDocAId)?.id ?? secondDoc.id;
    });
  }, [alignmentOpen, docsFiles, alignmentDocAId]);

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="header">
        <div className="header-inner">
          <div className="logo-block">
            <span className="logo-title">Horizon<sup className="logo-ai">AI</sup></span>
            <span className="logo-sub">bank</span>
          </div>
          <nav className="mode-toggle">
            <button
              className={`mode-btn ${mode === "chat" ? "active" : ""}`}
              onClick={() => setMode("chat")}
            >
              Chat
            </button>
            <button
              className={`mode-btn ${mode === "documents" ? "active" : ""}`}
              onClick={() => setMode("documents")}
            >
              Documents
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="main">
        {mode === "documents" ? (
          <section className="docs-section">
            <div className="docs-container">
              <div className="docs-header">
                <div>
                  <h1 className="docs-title">Document Management</h1>
                  <p className="docs-subtitle">
                    Upload and manage your strategy documents
                  </p>
                </div>
                <div className="docs-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleSyncDatabricks}
                    disabled={syncing}
                    title="Sync data from Databricks into Supabase"
                  >
                    {syncing ? "Syncing…" : "Sync Databricks"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleIngestSubmit}
                    disabled={ingesting}
                  >
                    {ingesting ? "Ingesting..." : "Run Ingest"}
                  </button>
                  {docsFiles.length >= 2 && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={openAlignmentModal}
                    >
                      Check Alignment
                    </button>
                  )}
                </div>
              </div>

              <div className="docs-upload-area">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.md,.csv"
                  className="file-input"
                  onChange={(e) => setPendingFiles(Array.from(e.target.files ?? []))}
                />
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleUploadSubmit}
                  disabled={uploading || pendingFiles.length === 0}
                >
                  {uploading ? "Uploading..." : `Upload ${pendingFiles.length > 0 ? `(${pendingFiles.length})` : ''}`}
                </button>
              </div>

              {docsNotice && <div className="docs-notice">{docsNotice}</div>}

              <div className="docs-grid">
                {docsFiles.length === 0 ? (
                  <div className="docs-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                      <polyline points="13 2 13 9 20 9"/>
                    </svg>
                    <p>No documents uploaded yet</p>
                  </div>
                ) : (
                  docsFiles.map((doc) => (
                    <div key={doc.id} className="doc-card">
                      <div className="doc-card-header">
                        <span className="doc-icon">{getDocIcon(doc.extension)}</span>
                        {doc.location === "uploads" && (
                          <button
                            type="button"
                            className="doc-delete"
                            onClick={() => void handleDeleteUpload(doc.storedName)}
                            title="Delete"
                          >
                            ×
                          </button>
                        )}
                      </div>
                      <h3 className="doc-name">{doc.originalName}</h3>
                      <p className="doc-meta">
                        {doc.location} • {Math.max(1, Math.round(doc.size / 1024))} KB
                      </p>
                    </div>
                  ))
                )}
              </div>

              {ingestLogs.length > 0 && (
                <div className="docs-logs">
                  <h3>Ingest Log</h3>
                  <pre>{ingestLogs.join("\n")}</pre>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="chat-section">
            <div className="messages-wrapper">
              <div className="messages-container">
                {messages.length === 0 && (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                        <path d="M2 17l10 5 10-5"/>
                        <path d="M2 12l10 5 10-5"/>
                      </svg>
                    </div>
                    <h1 className="empty-title">Základní charakteristika banky</h1>
                    <p className="empty-body">
                      Poslání: Být bankou, která díky datům a AI rozumí životní situaci klienta a proaktivně 
                      mu pomáhá využívat finanční příležitosti ve správný čas.
                    </p>
                  </div>
                )}

                {messages.map((msg) => (
                  <div key={msg.id} className={`message ${msg.role}`}>
                    <div className="message-avatar">
                      {msg.role === "user" ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                          <circle cx="12" cy="7" r="4"/>
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                          <path d="M2 17l10 5 10-5"/>
                          <path d="M2 12l10 5 10-5"/>
                        </svg>
                      )}
                    </div>
                    <div className="message-content">
                      {msg.role === "assistant" ? (
                        <MessageContent text={getMessageText(msg)} />
                      ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {getMessageText(msg)}
                        </ReactMarkdown>
                      )}
                    </div>
                  </div>
                ))}

                {isLoading && (
                  <div className="message assistant">
                    <div className="message-avatar">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                        <path d="M2 17l10 5 10-5"/>
                        <path d="M2 12l10 5 10-5"/>
                      </svg>
                    </div>
                    <div className="typing-indicator">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                )}

                {error && (
                  <div className="error-banner">
                    ⚠ {error.message ?? "An error occurred. Please try again."}
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input Area */}
            <div className="input-wrapper">
              <div className="input-container">
                <form className="input-form" onSubmit={handleFormSubmit}>
                  <div className="input-actions">
                    <button
                      type="button"
                      className="action-btn"
                      onClick={() => setMode("documents")}
                      title="Manage documents"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                        <polyline points="13 2 13 9 20 9"/>
                      </svg>
                    </button>
                    {docsFiles.length >= 2 && (
                      <button
                        type="button"
                        className="action-btn"
                        onClick={openAlignmentModal}
                        title="Check alignment"
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <line x1="16" y1="13" x2="8" y2="13"/>
                          <line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                      </button>
                    )}
                  </div>
                  <input
                    className="chat-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask about strategy, risk, data, technology..."
                    disabled={isLoading}
                  />
                  <button
                    type="submit"
                    className="send-btn"
                    disabled={isLoading || !input.trim()}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13"/>
                      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  </button>
                </form>
                {docsFiles.length > 0 && (
                  <div className="active-docs-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                      <polyline points="13 2 13 9 20 9"/>
                    </svg>
                    {docsFiles.length} document{docsFiles.length !== 1 ? 's' : ''} active
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Alignment Modal - keeping the same from original */}
      {alignmentOpen && (
        <div className="alignment-modal-overlay" onClick={() => setAlignmentOpen(false)}>
          <div className="alignment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="alignment-modal-header">
              <div>
                <p className="alignment-title">Document Alignment Check</p>
                <p className="alignment-subtitle">
                  Compare two documents using chunk-level evidence
                </p>
              </div>
              <button type="button" className="alignment-close" onClick={() => setAlignmentOpen(false)}>
                ×
              </button>
            </div>

            <div className="alignment-modal-body">
              <div className="alignment-selectors">
                <div className="alignment-picker">
                  <div className="alignment-picker-header">
                    <label className="alignment-label">Document A</label>
                    {alignmentDocAId && (
                      <span className="alignment-selected-pill">
                        {docsFiles.find((doc) => doc.id === alignmentDocAId)?.originalName ?? alignmentDocAId}
                      </span>
                    )}
                  </div>
                  <input
                    className="alignment-search"
                    value={alignmentQueryA}
                    onChange={(e) => setAlignmentQueryA(e.target.value)}
                    placeholder="Search documents..."
                  />
                  <div className="alignment-doc-list">
                    {docsFiles
                      .filter((doc) => matchesDocQuery(doc, alignmentQueryA))
                      .map((doc) => (
                        <button
                          key={`a-${doc.id}`}
                          type="button"
                          className={`alignment-doc-item ${alignmentDocAId === doc.id ? "active" : ""}`}
                          onClick={() => setAlignmentDocAId(doc.id)}
                        >
                          <span className="alignment-doc-name">{doc.originalName}</span>
                          <span className="alignment-doc-meta">{doc.location}</span>
                        </button>
                      ))}
                  </div>
                </div>

                <div className="alignment-picker">
                  <div className="alignment-picker-header">
                    <label className="alignment-label">Document B</label>
                    {alignmentDocBId && (
                      <span className="alignment-selected-pill">
                        {docsFiles.find((doc) => doc.id === alignmentDocBId)?.originalName ?? alignmentDocBId}
                      </span>
                    )}
                  </div>
                  <input
                    className="alignment-search"
                    value={alignmentQueryB}
                    onChange={(e) => setAlignmentQueryB(e.target.value)}
                    placeholder="Search documents..."
                  />
                  <div className="alignment-doc-list">
                    {docsFiles
                      .filter((doc) => matchesDocQuery(doc, alignmentQueryB))
                      .map((doc) => (
                        <button
                          key={`b-${doc.id}`}
                          type="button"
                          className={`alignment-doc-item ${alignmentDocBId === doc.id ? "active" : ""}`}
                          onClick={() => setAlignmentDocBId(doc.id)}
                        >
                          <span className="alignment-doc-name">{doc.originalName}</span>
                          <span className="alignment-doc-meta">{doc.location}</span>
                        </button>
                      ))}
                  </div>
                </div>
              </div>

              <div className="alignment-results">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleRunAlignmentCheck}
                  disabled={alignmentLoading || !alignmentDocAId || !alignmentDocBId || alignmentDocAId === alignmentDocBId}
                >
                  {alignmentLoading ? "Checking..." : "Run Alignment Check"}
                </button>

                {alignmentError && <div className="error-banner">{alignmentError}</div>}

                {alignmentResult && (
                  <div className="alignment-result-card">
                    <div className="alignment-verdict-row">
                      <span className={`alignment-verdict alignment-verdict-${alignmentResult.verdict}`}>
                        {formatAlignmentVerdict(alignmentResult.verdict)}
                      </span>
                      <span className="alignment-confidence">
                        {Math.round(alignmentResult.confidence * 100)}% confidence
                      </span>
                    </div>
                    {alignmentResult.llm_summary && (
                      <p className="alignment-summary">{alignmentResult.llm_summary}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        /* Design System */
        :global(:root) {
          --bg: #0B0F17;
          --surface: #1F2937;
          --surface-hover: #374151;
          --text-primary: #FFFFFF;
          --text-secondary: #9CA3AF;
          --text-tertiary: #6B7280;
          --border: #1F2937;
          --accent: #4F8CFF;
          --accent-hover: #6BA0FF;
        }

        :global(*) { 
          box-sizing: border-box; 
          margin: 0; 
          padding: 0; 
        }

        :global(body) {
          font-family: 'Manrope', -apple-system, BlinkMacSystemFont, sans-serif;
          background: var(--bg);
          color: var(--text-primary);
          -webkit-font-smoothing: antialiased;
        }

        /* App Shell */
        .app-shell {
          display: flex;
          flex-direction: column;
          height: 100vh;
          overflow: hidden;
        }

        /* Header */
        .header {
          background: var(--bg);
          border-bottom: 1px solid var(--border);
          padding: 0 1rem;
          flex-shrink: 0;
        }

        .header-inner {
          max-width: 1280px;
          margin: 0 auto;
          height: 60px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .logo-block {
          display: flex;
          align-items: baseline;
          gap: 0.25rem;
        }

        .logo-title {
          font-size: 1.1rem;
          font-weight: 700;
          display: inline-block;
          background: linear-gradient(to bottom, #a6b8ec 0%, #e2e7f8 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          color: #a6b8ec;
        }

        .logo-ai {
          font-size: 0.65rem;
          font-weight: 700;
          background: linear-gradient(to bottom, #a6b8ec 0%, #e2e7f8 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          color: #a6b8ec;
        }

        .logo-sub {
          font-size: 1.1rem;
          font-weight: 700;
          background: linear-gradient(to bottom, #a6b8ec 0%, #e2e7f8 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          color: #a6b8ec;
        }

        .mode-toggle {
          display: flex;
          gap: 0.5rem;
        }

        .mode-btn {
          background: transparent;
          border: 1px solid transparent;
          color: var(--text-secondary);
          padding: 0.5rem 1rem;
          font-family: inherit;
          font-size: 0.875rem;
          cursor: pointer;
          border-radius: 6px;
          transition: all 0.2s;
          font-weight: 500;
        }

        .mode-btn:hover {
          background: var(--surface);
        }

        .mode-btn.active {
          color: var(--text-primary);
          background: var(--surface);
        }

        /* Main */
        .main {
          flex: 1;
          overflow: hidden;
          display: flex;
        }

        /* Chat Section */
        .chat-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .messages-wrapper {
          flex: 1;
          overflow-y: auto;
          display: flex;
          justify-content: center;
        }

        .messages-container {
          width: 100%;
          max-width: 768px;
          padding: 2rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 2rem;
        }

        /* Empty State */
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          padding: 4rem 2rem;
          gap: 1.5rem;
        }

        .empty-icon {
          color: var(--accent);
          opacity: 0.6;
        }

        .empty-title {
          font-size: 1.75rem;
          font-weight: 700;
          color: var(--text-primary);
        }

        .empty-body {
          font-size: 1rem;
          color: var(--text-secondary);
          line-height: 1.6;
          max-width: 560px;
        }

        /* Messages */
        .message {
          display: flex;
          gap: 1rem;
          padding: 1.5rem 0;
        }

        .message.user {
          background: rgba(79, 140, 255, 0.03);
          margin: 0 -1rem;
          padding: 1.5rem 1rem;
          border-radius: 8px;
        }

        .message-avatar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: var(--surface);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          color: var(--text-secondary);
        }

        .message.user .message-avatar {
          background: var(--accent);
          color: white;
        }

        .message-content {
          flex: 1;
          min-width: 0;
        }

        :global(.message-content p) {
          font-size: 0.95rem;
          line-height: 1.7;
          color: var(--text-primary);
          margin: 0.5rem 0;
        }

        :global(.message-content p:first-child) {
          margin-top: 0;
        }

        :global(.message-content code) {
          background: var(--surface);
          color: var(--accent);
          padding: 0.125rem 0.375rem;
          border-radius: 4px;
          font-size: 0.875em;
          font-family: 'Monaco', 'Courier New', monospace;
        }

        :global(.message-content table) {
          width: 100%;
          border-collapse: collapse;
          margin: 1rem 0;
        }

        :global(.message-content th) {
          background: var(--surface);
          padding: 0.75rem 1rem;
          text-align: left;
          font-weight: 600;
          border-bottom: 1px solid var(--border);
        }

        :global(.message-content td) {
          padding: 0.75rem 1rem;
          border-bottom: 1px solid var(--border);
        }

        /* Typing Indicator */
        .typing-indicator {
          display: flex;
          gap: 4px;
          padding: 0.5rem 0;
        }

        .typing-indicator span {
          width: 6px;
          height: 6px;
          background: var(--text-secondary);
          border-radius: 50%;
          animation: bounce 1.4s infinite;
        }

        .typing-indicator span:nth-child(2) {
          animation-delay: 0.2s;
        }

        .typing-indicator span:nth-child(3) {
          animation-delay: 0.4s;
        }

        @keyframes bounce {
          0%, 60%, 100% {
            transform: translateY(0);
            opacity: 0.4;
          }
          30% {
            transform: translateY(-8px);
            opacity: 1;
          }
        }

        /* Input Area */
        .input-wrapper {
          border-top: 1px solid var(--border);
          padding: 1.5rem 1rem;
          flex-shrink: 0;
          display: flex;
          justify-content: center;
        }

        .input-container {
          width: 100%;
          max-width: 768px;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }

        .input-form {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 24px;
          padding: 0.5rem;
          transition: border-color 0.2s;
        }

        .input-form:focus-within {
          border-color: var(--accent);
        }

        .input-actions {
          display: flex;
          gap: 0.25rem;
          padding-left: 0.25rem;
        }

        .action-btn {
          width: 36px;
          height: 36px;
          border: none;
          background: transparent;
          color: var(--text-secondary);
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }

        .action-btn:hover {
          background: var(--surface-hover);
          color: var(--text-primary);
        }

        .chat-input {
          flex: 1;
          background: transparent;
          border: none;
          color: var(--text-primary);
          font-family: inherit;
          font-size: 0.95rem;
          padding: 0.5rem 0.75rem;
          outline: none;
        }

        .chat-input::placeholder {
          color: var(--text-tertiary);
        }

        .send-btn {
          width: 36px;
          height: 36px;
          border: none;
          background: var(--accent);
          color: white;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }

        .send-btn:hover:not(:disabled) {
          background: var(--accent-hover);
        }

        .send-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .active-docs-badge {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.8rem;
          color: var(--text-tertiary);
          justify-content: center;
        }

        /* Documents Section */
        .docs-section {
          flex: 1;
          overflow-y: auto;
          display: flex;
          justify-content: center;
        }

        .docs-container {
          width: 100%;
          max-width: 1024px;
          padding: 2rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 2rem;
        }

        .docs-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 2rem;
          flex-wrap: wrap;
        }

        .docs-title {
          font-size: 1.5rem;
          font-weight: 700;
          color: var(--text-primary);
        }

        .docs-subtitle {
          font-size: 0.9rem;
          color: var(--text-secondary);
          margin-top: 0.5rem;
        }

        .docs-actions {
          display: flex;
          gap: 0.75rem;
        }

        .docs-upload-area {
          display: flex;
          gap: 0.75rem;
          flex-wrap: wrap;
        }

        .file-input {
          flex: 1;
          min-width: 200px;
          padding: 0.75rem 1rem;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--text-primary);
          font-size: 0.875rem;
        }

        .btn-primary {
          background: var(--accent);
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 8px;
          font-family: inherit;
          font-size: 0.875rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-primary:hover:not(:disabled) {
          background: var(--accent-hover);
        }

        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-secondary {
          background: var(--surface);
          color: var(--text-primary);
          border: 1px solid var(--border);
          padding: 0.75rem 1.5rem;
          border-radius: 8px;
          font-family: inherit;
          font-size: 0.875rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-secondary:hover:not(:disabled) {
          background: var(--surface-hover);
          border-color: var(--accent);
        }

        .btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .docs-notice {
          padding: 1rem;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          font-size: 0.875rem;
          color: var(--text-secondary);
        }

        .docs-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 1rem;
        }

        .docs-empty {
          grid-column: 1 / -1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1rem;
          padding: 4rem 2rem;
          text-align: center;
          color: var(--text-tertiary);
        }

        .doc-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          transition: all 0.2s;
        }

        .doc-card:hover {
          border-color: var(--accent);
          transform: translateY(-2px);
        }

        .doc-card-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .doc-icon {
          width: 40px;
          height: 40px;
          border-radius: 8px;
          background: rgba(79, 140, 255, 0.1);
          border: 1px solid rgba(79, 140, 255, 0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7rem;
          font-weight: 700;
          color: var(--accent);
        }

        .doc-delete {
          width: 28px;
          height: 28px;
          border-radius: 6px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-tertiary);
          font-size: 1.25rem;
          line-height: 1;
          cursor: pointer;
          transition: all 0.2s;
        }

        .doc-delete:hover {
          background: rgba(239, 68, 68, 0.1);
          border-color: rgba(239, 68, 68, 0.2);
          color: #EF4444;
        }

        .doc-name {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-primary);
          word-break: break-word;
        }

        .doc-meta {
          font-size: 0.8rem;
          color: var(--text-tertiary);
        }

        .docs-logs {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1.25rem;
        }

        .docs-logs h3 {
          font-size: 0.95rem;
          margin-bottom: 1rem;
          color: var(--text-primary);
        }

        .docs-logs pre {
          font-size: 0.8rem;
          color: var(--text-secondary);
          line-height: 1.6;
          white-space: pre-wrap;
        }

        /* Alignment Modal */
        .alignment-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.8);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          z-index: 50;
        }

        .alignment-modal {
          width: 100%;
          max-width: 900px;
          max-height: 90vh;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 16px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .alignment-modal-header {
          padding: 1.5rem;
          border-bottom: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 1rem;
        }

        .alignment-title {
          font-size: 1.1rem;
          font-weight: 700;
          color: var(--text-primary);
        }

        .alignment-subtitle {
          font-size: 0.85rem;
          color: var(--text-secondary);
          margin-top: 0.25rem;
        }

        .alignment-close {
          width: 36px;
          height: 36px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: transparent;
          color: var(--text-secondary);
          font-size: 1.5rem;
          line-height: 1;
          cursor: pointer;
          transition: all 0.2s;
        }

        .alignment-close:hover {
          background: var(--surface);
          color: var(--text-primary);
        }

        .alignment-modal-body {
          padding: 1.5rem;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .alignment-selectors {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }

        .alignment-picker {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }

        .alignment-picker-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.75rem;
        }

        .alignment-label {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--text-primary);
        }

        .alignment-selected-pill {
          font-size: 0.75rem;
          color: var(--text-secondary);
          background: var(--bg);
          border-radius: 12px;
          padding: 0.25rem 0.75rem;
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .alignment-search {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--text-primary);
          padding: 0.75rem;
          font-family: inherit;
          font-size: 0.875rem;
        }

        .alignment-search:focus {
          outline: none;
          border-color: var(--accent);
        }

        .alignment-doc-list {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          max-height: 200px;
          overflow-y: auto;
        }

        .alignment-doc-item {
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 0.75rem;
          cursor: pointer;
          text-align: left;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          transition: all 0.2s;
        }

        .alignment-doc-item:hover {
          border-color: var(--accent);
        }

        .alignment-doc-item.active {
          background: rgba(79, 140, 255, 0.1);
          border-color: var(--accent);
        }

        .alignment-doc-name {
          font-size: 0.875rem;
          color: var(--text-primary);
        }

        .alignment-doc-meta {
          font-size: 0.75rem;
          color: var(--text-tertiary);
        }

        .alignment-results {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .alignment-result-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .alignment-verdict-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          flex-wrap: wrap;
        }

        .alignment-verdict {
          padding: 0.375rem 0.875rem;
          border-radius: 16px;
          font-size: 0.85rem;
          font-weight: 600;
        }

        .alignment-verdict-aligned {
          background: rgba(34, 197, 94, 0.1);
          color: #22C55E;
        }

        .alignment-verdict-partial {
          background: rgba(234, 179, 8, 0.1);
          color: #EAB308;
        }

        .alignment-verdict-not_aligned {
          background: rgba(239, 68, 68, 0.1);
          color: #EF4444;
        }

        .alignment-verdict-insufficient_evidence {
          background: rgba(168, 85, 247, 0.1);
          color: #A855F7;
        }

        .alignment-confidence {
          font-size: 0.85rem;
          color: var(--text-secondary);
        }

        .alignment-summary {
          font-size: 0.9rem;
          color: var(--text-primary);
          line-height: 1.6;
        }

        /* Error Banner */
        .error-banner {
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.2);
          color: #EF4444;
          padding: 1rem;
          border-radius: 8px;
          font-size: 0.875rem;
        }

        /* Dashboard */
        .dashboard-loading {
          display: flex;
          align-items: center;
          padding: 1rem 0;
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 1rem;
          margin-top: 0.75rem;
        }

        .dashboard-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1rem 1.25rem 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }

        .dashboard-card-title {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--text-primary);
        }

        .dashboard-card-error {
          font-size: 0.8rem;
          color: #EF4444;
        }

        .dashboard-card-empty {
          font-size: 0.8rem;
          color: var(--text-tertiary);
        }

        /* Responsive */
        @media (max-width: 768px) {
          .header-inner {
            height: 56px;
          }

          .logo-title {
            font-size: 1rem;
          }

          .logo-sub {
            display: none;
          }

          .messages-container {
            padding: 1.5rem 1rem;
          }

          .message {
            gap: 0.75rem;
          }

          .message-avatar {
            width: 32px;
            height: 32px;
          }

          .input-wrapper {
            padding: 1rem;
          }

          .alignment-selectors {
            grid-template-columns: 1fr;
          }

          .docs-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

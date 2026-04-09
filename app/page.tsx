"use client";
/**
 * Horizon Bank Strategy Bot – Main Chat UI
 * File: /app/page.tsx
 *
 * Features:
 *  - Standard chat mode (RAG Q&A)
 *  - Documents mode for uploads, ingest, and alignment checks
 *  - Streaming responses via Vercel AI SDK useChat
 *  - Renders markdown tables from LLM output
 */

import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

export default function HorizonBotPage() {
  const [mode, setMode] = useState<Mode>("chat");
  const [input, setInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [docsFiles, setDocsFiles] = useState<ManagedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
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

  // Vercel AI SDK useChat: manages messages, input, and streaming state
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

  async function handleFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode === "documents") return;

    const text = input.trim();
    if (!text || isLoading) return;

    await sendMessage({ text }, { body: { mode: "chat" } });
    setInput("");
  }

  async function refreshDocuments() {
    const res = await fetch("/api/upload", { method: "GET" });
    if (!res.ok) {
      throw new Error("Failed to fetch documents list.");
    }

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
      for (const file of pendingFiles) {
        formData.append("files", file);
      }

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const payload = await parseApiResponse(res);
      if (!res.ok) {
        throw new Error(String(payload?.error ?? "Upload failed."));
      }

      const savedCount = Array.isArray(payload.saved) ? payload.saved.length : 0;
      const rejectedCount = Array.isArray(payload.rejected) ? payload.rejected.length : 0;
      setDocsNotice(`Upload complete: saved ${savedCount}, rejected ${rejectedCount}.`);
      setPendingFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await refreshDocuments();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed.";
      setDocsNotice(msg);
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

      if (!res.ok || payload?.ok === false) {
        throw new Error(String(payload?.error ?? "Ingest failed."));
      }

      const logs = Array.isArray(payload.logs) ? payload.logs : [];
      setIngestLogs(logs);
      setDocsNotice(
        `Ingest complete: files ${payload.filesProcessed ?? 0}, chunks ${payload.chunksInserted ?? 0}.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Ingest failed.";
      setDocsNotice(msg);
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
      if (!res.ok) {
        throw new Error(String(payload?.error ?? "Delete failed."));
      }

      setDocsNotice("Upload deleted.");
      await refreshDocuments();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed.";
      setDocsNotice(msg);
    }
  }

  async function handleRunAlignmentCheck() {
    if (!alignmentDocAId || !alignmentDocBId || alignmentDocAId === alignmentDocBId || alignmentLoading) {
      return;
    }

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
      if (!res.ok) {
        throw new Error(String(payload?.error ?? "Alignment check failed."));
      }

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

  // Auto-scroll to bottom on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    refreshDocuments().catch(() => {
      setDocsNotice("Unable to load document inventory.");
    });
  }, []);

  useEffect(() => {
    if (!alignmentOpen || docsFiles.length === 0) {
      return;
    }

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
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-inner">
          <div className="logo-block">
            <span className="logo-mark">H</span>
            <div>
              <p className="logo-title">HORIZON BANK</p>
              <p className="logo-sub">Strategy Intelligence System</p>
            </div>
          </div>
          <nav className="mode-toggle">
            <button
              className={`mode-btn ${mode === "chat" ? "active" : ""}`}
              onClick={() => setMode("chat")}
            >
              Query Mode
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

      {/* ── Main Layout ─────────────────────────────────────────────────── */}
      <main className="main">
        {mode === "documents" ? (
          <section className="docs-section">
            <div className="docs-toolbar">
              <div className="docs-title-wrap">
                <p className="docs-title">Document Runtime Store</p>
                <p className="docs-subtitle">
                  Upload .pdf, .docx, .txt, .md, .csv files and run ingest into Supabase embeddings.
                </p>
              </div>

              <div className="docs-actions">
                <button
                  type="button"
                  className="docs-btn primary"
                  onClick={handleIngestSubmit}
                  disabled={ingesting}
                >
                  {ingesting ? "Ingesting..." : "Run Ingest"}
                </button>
                <button
                  type="button"
                  className="docs-btn secondary"
                  onClick={openAlignmentModal}
                  disabled={docsFiles.length < 2}
                >
                  Is it aligned?
                </button>
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
                  className="docs-btn"
                  onClick={handleUploadSubmit}
                  disabled={uploading || pendingFiles.length === 0}
                >
                  {uploading ? "Uploading..." : `Upload (${pendingFiles.length})`}
                </button>
              </div>
            </div>

            {docsNotice && <div className="docs-notice">{docsNotice}</div>}

            <div className="docs-grid">
              <div className="docs-card">
                <p className="docs-card-title">Available files</p>
                {docsFiles.length === 0 ? (
                  <p className="docs-empty">No documents found in docs or data/uploads.</p>
                ) : (
                  <div className="docs-segment-grid">
                    {docsFiles.map((doc) => (
                      <article key={doc.id} className="docs-segment-card">
                        <div className="docs-segment-head">
                          <span className="docs-segment-icon">{getDocIcon(doc.extension)}</span>
                          {doc.location === "uploads" && (
                            <button
                              type="button"
                              className="docs-delete-btn"
                              onClick={() => void handleDeleteUpload(doc.storedName)}
                              aria-label={`Delete ${doc.originalName}`}
                              title="Delete upload"
                            >
                              X
                            </button>
                          )}
                        </div>
                        <p className="docs-segment-title">{doc.originalName}</p>
                        <p className="docs-segment-body">
                          {doc.location === "docs" ? "Base strategy source document." : "Runtime uploaded source document."}
                        </p>
                        <p className="docs-segment-meta">{doc.location} • {Math.max(1, Math.round(doc.size / 1024))} KB</p>
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <div className="docs-card">
                <p className="docs-card-title">Ingest log</p>
                {ingestLogs.length === 0 ? (
                  <p className="docs-empty">Run ingest to see progress and summary.</p>
                ) : (
                  <pre className="docs-log">{ingestLogs.join("\n")}</pre>
                )}
              </div>
            </div>
          </section>
        ) : (
          <>
            {/* Message Thread */}
            <section className="chat-section">
          <section className="slide-hero">
            <h1 className="slide-title">Základní charakteristika banky</h1>
            <p className="slide-mission">
              Poslání: Být bankou, která díky datům a AI rozumí životní situaci klienta a proaktivně
              mu pomáhá využívat finanční příležitosti ve správný čas.
            </p>
          </section>

          <div className="working-docs-strip">
            <div className="working-docs-title-wrap">
              <p className="working-docs-title">Cílové segmenty dokumentů</p>
              <p className="working-docs-subtitle">Dokumenty, se kterými aktuálně pracuje retrieval vrstva.</p>
            </div>
            <div className="working-docs-list">
              {docsFiles.length === 0 ? (
                <span className="working-docs-empty">No documents loaded yet.</span>
              ) : (
                docsFiles.map((doc) => (
                  <article key={doc.id} className="working-doc-card">
                    <span className="working-doc-icon">{getDocIcon(doc.extension)}</span>
                    <h3>{doc.originalName}</h3>
                    <p>{doc.location === "docs" ? "Core bank strategy source." : "Uploaded working source."}</p>
                  </article>
                ))
              )}
            </div>
          </div>

          <div className="messages-container">
            {messages.length === 0 && (
              <div className="empty-state">
                <p className="empty-icon">◈</p>
                <p className="empty-title">Strategy Intelligence Ready</p>
                <p className="empty-body">
                  Ask any question about Horizon Bank's strategy, architecture, or compliance posture.
                </p>
                <div className="example-pills">
                  {[
                    "What is the cloud migration target?",
                    "Explain the data mesh architecture.",
                    "What is the NPS target for 2026?",
                    "Summarise DORA compliance status.",
                  ].map((q) => (
                    <button
                      key={q}
                      className="pill"
                      onClick={() => {
                        setInput(q);
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`message-row ${msg.role === "user" ? "user" : "assistant"}`}
              >
                <div className="message-bubble">
                  <span className="message-role">
                    {msg.role === "user" ? "YOU" : "HORIZON AI"}
                  </span>
                  <div className="message-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {getMessageText(msg)}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="message-row assistant">
                <div className="message-bubble loading">
                  <span className="message-role">HORIZON AI</span>
                  <div className="typing-indicator">
                    <span />
                    <span />
                    <span />
                  </div>
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

          {/* Input Area */}
          <form className="input-form" onSubmit={handleFormSubmit}>
            <button
              type="button"
              className="add-docs-btn"
              onClick={() => setMode("documents")}
            >
              Add documents
            </button>
            <input
              className="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask if one document aligns with another, or ask about strategy, risk, data, technology…"
              disabled={isLoading}
            />
            <button
              type="submit"
              className="send-btn"
              disabled={isLoading || !input.trim()}
            >
              {isLoading ? "…" : "→"}
            </button>
          </form>

          <p className="disclaimer">
            Responses are generated exclusively from Horizon Bank internal documents.
            Not for external distribution.{" "}
            <a href="/api/health" target="_blank" rel="noopener" className="health-link">
              System diagnostics →
            </a>
          </p>
            </section>
          </>
        )}
      </main>

      {alignmentOpen && (
        <div className="alignment-modal-overlay" onClick={() => setAlignmentOpen(false)}>
          <div className="alignment-modal" onClick={(e) => e.stopPropagation()}>
            <div className="alignment-modal-header">
              <div>
                <p className="alignment-title">Is it aligned?</p>
                <p className="alignment-subtitle">
                  Compare two existing documents using grounded chunk-level evidence only.
                </p>
              </div>
              <button type="button" className="alignment-close" onClick={() => setAlignmentOpen(false)}>
                Close
              </button>
            </div>

            <div className="alignment-modal-body">
              <div className="alignment-selectors">
                <div className="alignment-picker">
                  <div className="alignment-picker-header">
                    <label className="alignment-label">Select Doc A</label>
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
                    placeholder="Search docs..."
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
                    <label className="alignment-label">Select Doc B</label>
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
                    placeholder="Search docs..."
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
                <div className="alignment-actions-row">
                  <button
                    type="button"
                    className="docs-btn primary"
                    onClick={handleRunAlignmentCheck}
                    disabled={alignmentLoading || !alignmentDocAId || !alignmentDocBId || alignmentDocAId === alignmentDocBId}
                  >
                    {alignmentLoading ? "Checking..." : "Run alignment check"}
                  </button>
                  {alignmentDocAId === alignmentDocBId && (
                    <span className="alignment-note">Pick two different documents.</span>
                  )}
                </div>

                {alignmentError && <div className="docs-notice">{alignmentError}</div>}

                {alignmentResult ? (
                  <>
                    <div className="alignment-summary-card">
                      <div className="alignment-verdict-row">
                        <span className={`alignment-verdict alignment-verdict-${alignmentResult.verdict}`}>
                          {formatAlignmentVerdict(alignmentResult.verdict)}
                        </span>
                        <span className="alignment-confidence">
                          Confidence {Math.round(alignmentResult.confidence * 100)}%
                        </span>
                      </div>

                      <div className="alignment-metrics">
                        <div><strong>Top score</strong><span>{alignmentResult.similarity.top.toFixed(3)}</span></div>
                        <div><strong>Avg top-k</strong><span>{alignmentResult.similarity.avgTopK.toFixed(3)}</span></div>
                        <div><strong>k</strong><span>{alignmentResult.similarity.k}</span></div>
                        <div><strong>Coverage</strong><span>{Math.round((alignmentResult.coverage?.supportedRatio ?? 0) * 100)}%</span></div>
                      </div>

                      {alignmentResult.llm_summary && (
                        <p className="alignment-summary-text">{alignmentResult.llm_summary}</p>
                      )}

                      {alignmentResult.warnings?.length ? (
                        <div className="alignment-warnings">
                          {alignmentResult.warnings.map((warning) => (
                            <p key={warning}>{warning}</p>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="alignment-evidence-card">
                      <p className="alignment-section-title">Evidence</p>
                      <div className="alignment-evidence-list">
                        {alignmentResult.evidence.length === 0 ? (
                          <p className="alignment-empty">No evidence pairs returned.</p>
                        ) : (
                          alignmentResult.evidence.map((pair) => (
                            <div key={`${pair.aChunkId}-${pair.bChunkId}`} className="alignment-evidence-item">
                              <div className="alignment-evidence-head">
                                <span>{pair.aDocName ?? alignmentDocAId} chunk {pair.aChunkIndex ?? "?"}</span>
                                <span>vs</span>
                                <span>{pair.bDocName ?? alignmentDocBId} chunk {pair.bChunkIndex ?? "?"}</span>
                                <span className="alignment-score">{pair.score.toFixed(3)}</span>
                              </div>
                              <div className="alignment-quotes">
                                <blockquote>
                                  <strong>A:</strong> {pair.aText}
                                </blockquote>
                                <blockquote>
                                  <strong>B:</strong> {pair.bText}
                                </blockquote>
                              </div>
                              <div className="alignment-chunk-ids">
                                <span>{pair.aChunkId}</span>
                                <span>{pair.bChunkId}</span>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="alignment-evidence-card">
                      <p className="alignment-section-title">Reasons</p>
                      {alignmentResult.reasons?.length ? (
                        <ul className="alignment-reasons">
                          {alignmentResult.reasons.map((reason, index) => (
                            <li key={`${reason.text}-${index}`}>
                              <span>{reason.text}</span>
                              <small>{reason.citations.join(", ")}</small>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="alignment-empty">No structured reasons were returned.</p>
                      )}
                    </div>

                    <div className="alignment-evidence-card">
                      <p className="alignment-section-title">Contradictions</p>
                      {alignmentResult.contradictions.length ? (
                        <div className="alignment-contradictions">
                          {alignmentResult.contradictions.map((contradiction) => (
                            <div key={`${contradiction.aChunkId}-${contradiction.bChunkId}`} className="alignment-contradiction-item">
                              <p>{contradiction.explanation}</p>
                              <blockquote>A: {contradiction.aQuote}</blockquote>
                              <blockquote>B: {contradiction.bQuote}</blockquote>
                              <div className="alignment-chunk-ids">
                                <span>{contradiction.aChunkId}</span>
                                <span>{contradiction.bChunkId}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="alignment-empty">No contradictions were identified in the provided evidence.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="alignment-empty-state">
                    Run the check to see similarity metrics, evidence pairs, and a grounded verdict.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        /* ── Design System ──────────────────────────────────────────────── */
        :global(:root) {
          --bg: #0B0F17;
          --surface: #111827;
          --surface-soft: #0f1725;
          --text-primary: #FFFFFF;
          --text-secondary: #9CA3AF;
          --line: #1F2937;
          --accent: #4F8CFF;
          --accent-soft: rgba(79, 140, 255, 0.14);
        }
        :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
        :global(body) {
          font-family: 'Manrope', sans-serif;
          background: var(--bg);
          color: var(--text-primary);
          min-height: 100vh;
        }

        /* ── App Shell ──────────────────────────────────────────────────── */
        .app-shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

        /* ── Header ─────────────────────────────────────────────────────── */
        .header {
          background: var(--bg);
          border-bottom: 1px solid var(--line);
          padding: 0 2rem;
          flex-shrink: 0;
        }
        .header-inner {
          max-width: 1400px;
          margin: 0 auto;
          height: 64px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .logo-block { display: flex; align-items: center; gap: 0.875rem; }
        .logo-mark {
          width: 36px; height: 36px;
          background: var(--accent);
          color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 1.1rem;
          border-radius: 4px;
        }
        .logo-title { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.18em; color: var(--text-primary); }
        .logo-sub { font-size: 0.65rem; color: var(--text-secondary); letter-spacing: 0.08em; }

        .mode-toggle { display: flex; gap: 0.5rem; }
        .mode-btn {
          background: transparent;
          border: 1px solid var(--line);
          color: var(--text-secondary);
          padding: 0.35rem 1rem;
          font-family: inherit;
          font-size: 0.7rem;
          letter-spacing: 0.1em;
          cursor: pointer;
          border-radius: 3px;
          transition: all 0.15s;
        }
        .mode-btn.active, .mode-btn:hover {
          border-color: var(--accent);
          color: var(--accent);
          background: var(--accent-soft);
        }

        /* ── Main ────────────────────────────────────────────────────────── */
        .main {
          flex: 1;
          display: flex;
          overflow: hidden;
          max-width: 1400px;
          width: 100%;
          margin: 0 auto;
        }

        .docs-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 1rem;
          padding: 1.5rem 2rem;
          overflow: auto;
        }
        .docs-toolbar {
          display: flex;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
          border: 1px solid var(--line);
          background: var(--surface);
          border-radius: 6px;
          padding: 1rem;
        }
        .docs-title { font-size: 0.95rem; color: var(--text-primary); letter-spacing: 0.03em; font-weight: 700; }
        .docs-subtitle { font-size: 0.74rem; color: var(--text-secondary); margin-top: 0.35rem; }
        .docs-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
        .file-input {
          background: var(--bg);
          border: 1px solid var(--line);
          color: var(--text-primary);
          padding: 0.45rem 0.6rem;
          border-radius: 4px;
          font-size: 0.7rem;
          max-width: 360px;
        }
        .docs-btn {
          background: transparent;
          border: 1px solid var(--accent);
          color: var(--accent);
          border-radius: 4px;
          padding: 0.55rem 0.9rem;
          font-family: inherit;
          font-size: 0.68rem;
          letter-spacing: 0.08em;
          cursor: pointer;
        }
        .docs-btn.secondary {
          border-color: var(--line);
          color: var(--text-secondary);
          background: var(--surface-soft);
        }
        .docs-btn.secondary:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent);
        }
        .docs-btn.primary { background: var(--accent); color: #fff; }
        .docs-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .docs-notice {
          border: 1px solid var(--line);
          background: var(--surface);
          color: var(--text-primary);
          padding: 0.8rem 1rem;
          border-radius: 4px;
          font-size: 0.72rem;
        }
        .docs-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
          min-height: 0;
        }
        .docs-card {
          border: 1px solid var(--line);
          background: var(--surface);
          border-radius: 6px;
          padding: 1rem;
          min-height: 320px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .docs-card-title {
          font-size: 0.7rem;
          color: var(--text-secondary);
          letter-spacing: 0.1em;
          margin-bottom: 0.9rem;
        }
        .docs-empty { font-size: 0.72rem; color: var(--text-secondary); }
        .docs-list {
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
          overflow: auto;
        }
        .docs-list-item {
          border: 1px solid var(--line);
          border-radius: 4px;
          padding: 0.6rem 0.7rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.75rem;
        }
        .docs-right {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          flex-shrink: 0;
        }
        .docs-name {
          font-size: 0.72rem;
          color: var(--text-primary);
          word-break: break-all;
        }
        .docs-segment-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 0.8rem;
          overflow: auto;
          padding-right: 0.2rem;
        }
        .docs-segment-card {
          border: 1px solid var(--line);
          background: linear-gradient(165deg, #101a2a 0%, #0f1725 100%);
          border-radius: 8px;
          padding: 0.85rem;
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
          min-height: 145px;
        }
        .docs-segment-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.6rem;
        }
        .docs-segment-icon {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--accent-soft);
          border: 1px solid rgba(79, 140, 255, 0.35);
          font-size: 0.95rem;
        }
        .docs-segment-title {
          font-size: 0.76rem;
          color: var(--text-primary);
          line-height: 1.45;
          font-weight: 700;
          word-break: break-word;
        }
        .docs-segment-body {
          font-size: 0.67rem;
          color: var(--text-secondary);
          line-height: 1.5;
          min-height: 2.1em;
        }
        .docs-segment-meta {
          margin-top: auto;
          font-size: 0.62rem;
          color: var(--accent);
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .docs-meta {
          font-size: 0.65rem;
          color: var(--text-secondary);
          flex-shrink: 0;
        }
        .docs-delete-btn {
          width: 22px;
          height: 22px;
          border-radius: 999px;
          border: 1px solid #7f1d1d;
          background: rgba(127, 29, 29, 0.2);
          color: #fca5a5;
          font-family: inherit;
          font-size: 0.6rem;
          line-height: 1;
          cursor: pointer;
        }
        .docs-delete-btn:hover {
          background: rgba(185, 28, 28, 0.28);
          border-color: #b91c1c;
          color: #fecaca;
        }
        .docs-log {
          font-size: 0.68rem;
          color: var(--text-primary);
          background: var(--bg);
          border: 1px solid var(--line);
          border-radius: 4px;
          padding: 0.75rem;
          line-height: 1.5;
          overflow: auto;
          white-space: pre-wrap;
          flex: 1;
        }

        @media (max-width: 960px) {
          .docs-grid {
            grid-template-columns: 1fr;
          }
          .docs-segment-grid {
            grid-template-columns: 1fr;
          }
        }

        /* ── Alignment Modal ───────────────────────────────────────────── */
        .alignment-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(3, 8, 18, 0.82);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1.25rem;
          z-index: 60;
        }
        .alignment-modal {
          width: min(1180px, 100%);
          max-height: 92vh;
          background: #0d1117;
          border: 1px solid #1e2530;
          border-radius: 16px;
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .alignment-modal-header {
          padding: 1rem 1.25rem;
          border-bottom: 1px solid #1e2530;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
        }
        .alignment-title { font-size: 0.95rem; color: #e2e8f0; letter-spacing: 0.08em; }
        .alignment-subtitle { font-size: 0.68rem; color: #718096; margin-top: 0.25rem; }
        .alignment-close {
          border: 1px solid #233048;
          background: #0a1322;
          color: #9ab4db;
          border-radius: 999px;
          padding: 0.5rem 0.85rem;
          font-family: inherit;
          cursor: pointer;
          font-size: 0.7rem;
        }
        .alignment-close:hover { border-color: #1a6ef5; color: #1a6ef5; }
        .alignment-modal-body {
          display: grid;
          grid-template-columns: minmax(320px, 380px) 1fr;
          gap: 1rem;
          padding: 1rem;
          min-height: 0;
          overflow: hidden;
        }
        .alignment-selectors {
          display: grid;
          gap: 1rem;
          min-height: 0;
        }
        .alignment-picker {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          min-height: 0;
          border: 1px solid #1e2530;
          border-radius: 12px;
          background: #0a0c10;
          padding: 0.9rem;
        }
        .alignment-picker-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
        }
        .alignment-label {
          font-size: 0.68rem;
          letter-spacing: 0.12em;
          color: #9fb1cc;
          text-transform: uppercase;
        }
        .alignment-selected-pill {
          font-size: 0.62rem;
          color: #9ab4db;
          border: 1px solid #233048;
          background: rgba(10, 19, 34, 0.8);
          border-radius: 999px;
          padding: 0.2rem 0.5rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 190px;
        }
        .alignment-search {
          background: #0d1117;
          border: 1px solid #1e2530;
          border-radius: 8px;
          color: #c8d0dc;
          padding: 0.7rem 0.8rem;
          font-family: inherit;
          font-size: 0.72rem;
        }
        .alignment-search:focus { outline: none; border-color: #1a6ef5; }
        .alignment-doc-list {
          display: flex;
          flex-direction: column;
          gap: 0.45rem;
          overflow: auto;
          max-height: 220px;
          padding-right: 0.15rem;
        }
        .alignment-doc-item {
          border: 1px solid #1e2530;
          background: #0d1117;
          color: #c8d0dc;
          border-radius: 10px;
          padding: 0.72rem 0.8rem;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 0.25rem;
          cursor: pointer;
          text-align: left;
        }
        .alignment-doc-item:hover { border-color: #1a6ef5; }
        .alignment-doc-item.active {
          border-color: #1a6ef5;
          background: rgba(26, 110, 245, 0.08);
        }
        .alignment-doc-name {
          font-size: 0.72rem;
          color: #e2e8f0;
          word-break: break-all;
        }
        .alignment-doc-meta {
          font-size: 0.6rem;
          color: #718096;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .alignment-results {
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          min-height: 0;
          overflow: auto;
          padding-right: 0.15rem;
        }
        .alignment-actions-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          flex-wrap: wrap;
        }
        .alignment-note {
          font-size: 0.68rem;
          color: #718096;
        }
        .alignment-summary-card,
        .alignment-evidence-card {
          border: 1px solid #1e2530;
          border-radius: 12px;
          background: #0a0c10;
          padding: 0.95rem;
        }
        .alignment-verdict-row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          flex-wrap: wrap;
          margin-bottom: 0.75rem;
        }
        .alignment-verdict,
        .alignment-confidence {
          border-radius: 999px;
          padding: 0.28rem 0.65rem;
          font-size: 0.68rem;
          letter-spacing: 0.05em;
        }
        .alignment-verdict { border: 1px solid transparent; text-transform: uppercase; }
        .alignment-verdict-aligned { color: #86efac; border-color: rgba(34, 197, 94, 0.35); background: rgba(22, 101, 52, 0.2); }
        .alignment-verdict-partial { color: #fde68a; border-color: rgba(202, 138, 4, 0.35); background: rgba(113, 63, 18, 0.2); }
        .alignment-verdict-not_aligned { color: #fca5a5; border-color: rgba(239, 68, 68, 0.35); background: rgba(127, 29, 29, 0.2); }
        .alignment-verdict-insufficient_evidence { color: #c4b5fd; border-color: rgba(139, 92, 246, 0.35); background: rgba(91, 33, 182, 0.2); }
        .alignment-confidence { border: 1px solid #233048; color: #9ab4db; background: rgba(10, 19, 34, 0.8); }
        .alignment-metrics {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 0.5rem;
          margin-bottom: 0.75rem;
        }
        .alignment-metrics div {
          border: 1px solid #1e2530;
          border-radius: 10px;
          padding: 0.65rem 0.7rem;
          background: #0d1117;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .alignment-metrics strong {
          font-size: 0.62rem;
          color: #718096;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .alignment-metrics span { font-size: 0.82rem; color: #e2e8f0; }
        .alignment-summary-text {
          font-size: 0.74rem;
          color: #c8d0dc;
          line-height: 1.7;
        }
        .alignment-warnings {
          margin-top: 0.75rem;
          border-left: 2px solid #f59e0b;
          padding-left: 0.75rem;
          color: #fbbf24;
          font-size: 0.68rem;
          display: grid;
          gap: 0.25rem;
        }
        .alignment-section-title {
          font-size: 0.68rem;
          letter-spacing: 0.12em;
          color: #9fb1cc;
          text-transform: uppercase;
          margin-bottom: 0.65rem;
        }
        .alignment-evidence-list,
        .alignment-contradictions {
          display: grid;
          gap: 0.75rem;
        }
        .alignment-evidence-item,
        .alignment-contradiction-item {
          border: 1px solid #1e2530;
          border-radius: 10px;
          padding: 0.8rem;
          background: #0d1117;
          display: grid;
          gap: 0.6rem;
        }
        .alignment-evidence-head {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          font-size: 0.64rem;
          color: #9ab4db;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .alignment-score {
          margin-left: auto;
          color: #1a6ef5;
          font-weight: 700;
        }
        .alignment-quotes {
          display: grid;
          gap: 0.5rem;
        }
        .alignment-quotes blockquote,
        .alignment-contradiction-item blockquote {
          margin: 0;
          border-left: 2px solid #233048;
          padding-left: 0.75rem;
          font-size: 0.72rem;
          color: #c8d0dc;
          line-height: 1.65;
          white-space: pre-wrap;
        }
        .alignment-chunk-ids {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
          font-size: 0.6rem;
          color: #718096;
        }
        .alignment-chunk-ids span {
          border: 1px solid #1e2530;
          border-radius: 999px;
          padding: 0.18rem 0.45rem;
          background: #0a0c10;
        }
        .alignment-reasons {
          display: grid;
          gap: 0.6rem;
          list-style: none;
        }
        .alignment-reasons li {
          display: grid;
          gap: 0.25rem;
          border: 1px solid #1e2530;
          border-radius: 10px;
          padding: 0.7rem;
          background: #0d1117;
        }
        .alignment-reasons span { font-size: 0.72rem; color: #d6deea; line-height: 1.55; }
        .alignment-reasons small { font-size: 0.6rem; color: #718096; }
        .alignment-empty,
        .alignment-empty-state {
          font-size: 0.72rem;
          color: #60708a;
          line-height: 1.6;
        }

        @media (max-width: 1100px) {
          .alignment-modal-body {
            grid-template-columns: 1fr;
          }
          .alignment-metrics {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (max-width: 720px) {
          .alignment-modal-overlay {
            padding: 0.6rem;
          }
          .alignment-modal-header,
          .alignment-modal-body {
            padding: 0.85rem;
          }
          .alignment-metrics {
            grid-template-columns: 1fr;
          }
        }

        /* ── Chat Section ────────────────────────────────────────────────── */
        .chat-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .slide-hero {
          position: relative;
          border-bottom: 1px solid var(--line);
          background:
            radial-gradient(circle at 12% 20%, rgba(79, 140, 255, 0.22), transparent 48%),
            radial-gradient(circle at 80% -15%, rgba(118, 186, 255, 0.16), transparent 42%),
            linear-gradient(160deg, #0f1726 0%, #0b111b 100%);
          padding: 1.6rem 1.8rem 1.4rem;
          animation: heroReveal 0.45s ease-out;
        }
        .slide-title {
          font-size: clamp(1.2rem, 2.3vw, 1.9rem);
          line-height: 1.12;
          letter-spacing: 0.01em;
          color: #f8fbff;
          max-width: 720px;
        }
        .slide-mission {
          margin-top: 0.75rem;
          max-width: 980px;
          font-size: clamp(0.78rem, 1.15vw, 0.96rem);
          color: #d5dcea;
          line-height: 1.75;
        }
        .working-docs-strip {
          border-bottom: 1px solid var(--line);
          background: var(--surface);
          padding: 0.95rem 1.25rem 1.1rem;
          display: flex;
          flex-direction: column;
          gap: 0.65rem;
        }
        .working-docs-title-wrap {
          display: flex;
          flex-direction: column;
          gap: 0.18rem;
        }
        .working-docs-title {
          font-size: 0.7rem;
          color: var(--text-primary);
          letter-spacing: 0.13em;
        }
        .working-docs-subtitle {
          font-size: 0.64rem;
          color: var(--text-secondary);
        }
        .working-docs-list {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 0.55rem;
          max-height: 146px;
          overflow-y: auto;
        }
        .working-doc-card {
          border: 1px solid var(--line);
          border-radius: 8px;
          background: linear-gradient(170deg, #121b2c 0%, #111827 100%);
          padding: 0.6rem 0.72rem;
          display: grid;
          grid-template-columns: 28px 1fr;
          column-gap: 0.55rem;
          row-gap: 0.15rem;
          align-items: start;
        }
        .working-doc-icon {
          grid-row: 1 / span 2;
          width: 28px;
          height: 28px;
          border-radius: 6px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--accent-soft);
          border: 1px solid rgba(79, 140, 255, 0.35);
          font-size: 0.9rem;
        }
        .working-doc-card h3 {
          font-size: 0.68rem;
          color: var(--text-primary);
          line-height: 1.35;
          font-weight: 700;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .working-doc-card p {
          font-size: 0.62rem;
          color: var(--text-secondary);
          line-height: 1.35;
        }
        .working-doc-chip {
          font-size: 0.62rem;
          border: 1px solid var(--line);
          color: var(--text-secondary);
          border-radius: 999px;
          padding: 0.2rem 0.55rem;
          background: var(--bg);
          max-width: 280px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .working-docs-empty { font-size: 0.66rem; color: var(--text-secondary); }
        .messages-container {
          flex: 1;
          overflow-y: auto;
          padding: 2rem;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        /* ── Empty State ─────────────────────────────────────────────────── */
        .empty-state {
          margin: auto;
          text-align: center;
          max-width: 520px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1rem;
          padding: 3rem 0;
        }
        .empty-icon { font-size: 2.5rem; color: var(--accent); opacity: 0.8; }
        .empty-title { font-size: 1.1rem; color: var(--text-primary); font-weight: 700; }
        .empty-body { font-size: 0.8rem; color: var(--text-secondary); line-height: 1.7; }
        .example-pills { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
        .pill {
          background: transparent;
          border: 1px solid var(--line);
          color: var(--text-secondary);
          padding: 0.35rem 0.85rem;
          font-family: inherit;
          font-size: 0.65rem;
          cursor: pointer;
          border-radius: 100px;
          transition: all 0.15s;
          letter-spacing: 0.05em;
        }
        .pill:hover { border-color: var(--accent); color: var(--accent); }

        /* ── Messages ────────────────────────────────────────────────────── */
        .message-row { display: flex; }
        .message-row.user { justify-content: flex-end; }
        .message-row.assistant { justify-content: flex-start; }
        .message-bubble {
          max-width: 85%;
          background: var(--surface);
          border: 1px solid var(--line);
          border-radius: 6px;
          padding: 1rem 1.25rem;
        }
        .message-row.user .message-bubble { border-color: var(--accent); background: var(--surface-soft); }
        .message-role {
          display: block;
          font-size: 0.58rem;
          letter-spacing: 0.18em;
          color: var(--text-secondary);
          margin-bottom: 0.5rem;
        }
        .message-row.user .message-role { color: var(--accent); }

        /* Markdown table styling */
        :global(.message-content table) {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.75rem;
          margin-top: 0.5rem;
        }
        :global(.message-content th) {
          background: var(--surface-soft);
          color: var(--accent);
          text-align: left;
          padding: 0.5rem 0.75rem;
          font-size: 0.65rem;
          letter-spacing: 0.1em;
          border-bottom: 1px solid var(--line);
        }
        :global(.message-content td) {
          padding: 0.6rem 0.75rem;
          border-bottom: 1px solid var(--line);
          color: var(--text-primary);
          line-height: 1.5;
          vertical-align: top;
        }
        :global(.message-content tr:last-child td) { border-bottom: none; }
        :global(.message-content p) { font-size: 0.8rem; line-height: 1.7; }
        :global(.message-content code) {
          background: var(--surface-soft);
          padding: 0.1rem 0.3rem;
          border-radius: 3px;
          font-size: 0.75em;
        }

        /* Typing indicator */
        .loading { opacity: 0.7; }
        .typing-indicator { display: flex; gap: 4px; align-items: center; height: 20px; }
        .typing-indicator span {
          width: 5px; height: 5px;
          background: var(--accent);
          border-radius: 50%;
          animation: blink 1.2s infinite;
        }
        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes blink {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.9); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes heroReveal {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        /* ── Input Area ──────────────────────────────────────────────────── */
        .input-form {
          display: flex;
          gap: 0.5rem;
          padding: 1rem 2rem;
          border-top: 1px solid var(--line);
          background: var(--surface);
        }
        .add-docs-btn {
          border: 1px solid var(--line);
          background: var(--bg);
          color: var(--text-secondary);
          border-radius: 4px;
          padding: 0 0.85rem;
          font-size: 0.68rem;
          letter-spacing: 0.05em;
          font-family: inherit;
          cursor: pointer;
          flex-shrink: 0;
        }
        .add-docs-btn:hover {
          border-color: var(--accent);
          color: var(--accent);
        }
        .chat-input {
          flex: 1;
          background: var(--bg);
          border: 1px solid var(--line);
          border-radius: 4px;
          color: var(--text-primary);
          font-family: inherit;
          font-size: 0.8rem;
          padding: 0.75rem 1rem;
        }
        .chat-input:focus { outline: none; border-color: var(--accent); }
        .chat-input::placeholder { color: var(--text-secondary); }
        .send-btn {
          background: var(--accent);
          border: none;
          color: white;
          width: 44px;
          height: 44px;
          border-radius: 4px;
          font-size: 1.1rem;
          cursor: pointer;
          transition: background 0.15s;
          flex-shrink: 0;
        }
        .send-btn:hover:not(:disabled) { filter: brightness(0.92); }
        .send-btn:disabled { background: var(--line); cursor: not-allowed; }

        /* ── Footer Disclaimer ───────────────────────────────────────────── */
        .disclaimer {
          text-align: center;
          font-size: 0.6rem;
          color: var(--text-secondary);
          padding: 0.5rem 2rem 0.75rem;
          letter-spacing: 0.05em;
        }
        .health-link {
          color: var(--text-secondary);
          text-decoration: none;
        }
        .health-link:hover { color: var(--accent); }

        /* ── Error ───────────────────────────────────────────────────────── */
        .error-banner {
          background: rgba(220, 38, 38, 0.1);
          border: 1px solid rgba(220, 38, 38, 0.3);
          color: #fc8181;
          padding: 0.75rem 1rem;
          border-radius: 4px;
          font-size: 0.75rem;
        }

        @media (max-width: 900px) {
          .slide-hero {
            padding: 1.15rem 1rem 1rem;
          }
          .working-docs-strip {
            padding: 0.85rem 1rem 1rem;
          }
          .working-docs-list {
            grid-template-columns: 1fr;
            max-height: 170px;
          }
          .messages-container {
            padding: 1.2rem 1rem;
          }
          .input-form {
            padding: 0.8rem 1rem;
          }
        }

        @media (max-width: 640px) {
          .header {
            padding: 0 0.8rem;
          }
          .header-inner {
            height: 70px;
          }
          .mode-btn {
            padding: 0.32rem 0.72rem;
          }
          .logo-sub {
            display: none;
          }
          .docs-section {
            padding: 1rem 0.8rem;
          }
          .docs-toolbar {
            padding: 0.8rem;
          }
          .file-input {
            width: 100%;
            max-width: 100%;
          }
          .docs-actions {
            width: 100%;
          }
          .docs-btn {
            flex: 1;
            min-width: 130px;
          }
          .slide-title {
            font-size: 1.08rem;
          }
          .slide-mission {
            font-size: 0.76rem;
            line-height: 1.65;
          }
          .disclaimer {
            padding: 0.45rem 0.9rem 0.65rem;
          }
        }
      `}</style>
    </div>
  );
}
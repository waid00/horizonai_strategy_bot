"use client";
/**
 * Horizon Bank Strategy Bot – Main Chat UI
 * File: /app/page.tsx
 *
 * Features:
 *  - Standard chat mode (RAG Q&A)
 *  - Gap Analysis mode (external text vs. internal docs)
 *  - Streaming responses via Vercel AI SDK useChat
 *  - Renders markdown tables from LLM output
 */

import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Mode = "chat" | "gap-analysis";

export default function HorizonBotPage() {
  const [mode, setMode] = useState<Mode>("chat");
  const [externalText, setExternalText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Vercel AI SDK useChat: manages messages, input, and streaming state
  const { messages, input, handleInputChange, handleSubmit, isLoading, error } =
    useChat({
      api: "/api/chat",
      // Inject mode and externalText into every request body
      body: { mode, externalText: mode === "gap-analysis" ? externalText : undefined },
    });

  // Auto-scroll to bottom on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
              className={`mode-btn ${mode === "gap-analysis" ? "active" : ""}`}
              onClick={() => setMode("gap-analysis")}
            >
              Gap Analysis
            </button>
          </nav>
        </div>
      </header>

      {/* ── Main Layout ─────────────────────────────────────────────────── */}
      <main className="main">
        {/* Gap Analysis Panel */}
        {mode === "gap-analysis" && (
          <aside className="gap-panel">
            <label className="gap-label">
              External Document / Current State Input
              <span className="gap-hint">
                Paste external strategy text to compare against Horizon Bank internal data
              </span>
            </label>
            <textarea
              className="gap-textarea"
              value={externalText}
              onChange={(e) => setExternalText(e.target.value)}
              placeholder="Paste external bank strategy, competitor analysis, or current state description here…"
              rows={10}
            />
          </aside>
        )}

        {/* Message Thread */}
        <section className="chat-section">
          <div className="messages-container">
            {messages.length === 0 && (
              <div className="empty-state">
                <p className="empty-icon">◈</p>
                <p className="empty-title">Strategy Intelligence Ready</p>
                <p className="empty-body">
                  {mode === "chat"
                    ? "Ask any question about Horizon Bank's strategy, architecture, or compliance posture."
                    : "Submit external text in the left panel, then ask a comparison question."}
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
                        // Inject example question into input
                        const syntheticEvent = {
                          target: { value: q },
                        } as React.ChangeEvent<HTMLInputElement>;
                        handleInputChange(syntheticEvent);
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
                      {msg.content}
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
          <form className="input-form" onSubmit={handleSubmit}>
            <input
              className="chat-input"
              value={input}
              onChange={handleInputChange}
              placeholder={
                mode === "gap-analysis"
                  ? "Ask what gaps exist between the external text and Horizon Bank strategy…"
                  : "Ask about Horizon Bank strategy, risk, data, technology…"
              }
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
            Not for external distribution.
          </p>
        </section>
      </main>

      <style jsx>{`
        /* ── Design System ──────────────────────────────────────────────── */
        :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
        :global(body) {
          font-family: 'DM Mono', 'Courier New', monospace;
          background: #0a0c10;
          color: #c8d0dc;
          min-height: 100vh;
        }

        /* ── App Shell ──────────────────────────────────────────────────── */
        .app-shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

        /* ── Header ─────────────────────────────────────────────────────── */
        .header {
          background: #0d1117;
          border-bottom: 1px solid #1e2530;
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
          background: #1a6ef5;
          color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 1.1rem;
          border-radius: 4px;
        }
        .logo-title { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.2em; color: #e2e8f0; }
        .logo-sub { font-size: 0.65rem; color: #4a5568; letter-spacing: 0.1em; }

        .mode-toggle { display: flex; gap: 0.5rem; }
        .mode-btn {
          background: transparent;
          border: 1px solid #1e2530;
          color: #4a5568;
          padding: 0.35rem 1rem;
          font-family: inherit;
          font-size: 0.7rem;
          letter-spacing: 0.1em;
          cursor: pointer;
          border-radius: 3px;
          transition: all 0.15s;
        }
        .mode-btn.active, .mode-btn:hover {
          border-color: #1a6ef5;
          color: #1a6ef5;
          background: rgba(26, 110, 245, 0.08);
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

        /* ── Gap Panel ───────────────────────────────────────────────────── */
        .gap-panel {
          width: 360px;
          flex-shrink: 0;
          border-right: 1px solid #1e2530;
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          background: #0d1117;
        }
        .gap-label {
          font-size: 0.65rem;
          letter-spacing: 0.12em;
          color: #718096;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .gap-hint { font-size: 0.6rem; color: #4a5568; letter-spacing: 0.05em; }
        .gap-textarea {
          flex: 1;
          background: #0a0c10;
          border: 1px solid #1e2530;
          border-radius: 4px;
          color: #c8d0dc;
          font-family: inherit;
          font-size: 0.75rem;
          padding: 0.75rem;
          resize: none;
          line-height: 1.6;
        }
        .gap-textarea:focus { outline: none; border-color: #1a6ef5; }

        /* ── Chat Section ────────────────────────────────────────────────── */
        .chat-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
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
        .empty-icon { font-size: 2.5rem; color: #1a6ef5; opacity: 0.7; }
        .empty-title { font-size: 1.1rem; color: #e2e8f0; font-weight: 600; }
        .empty-body { font-size: 0.8rem; color: #4a5568; line-height: 1.7; }
        .example-pills { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
        .pill {
          background: transparent;
          border: 1px solid #1e2530;
          color: #718096;
          padding: 0.35rem 0.85rem;
          font-family: inherit;
          font-size: 0.65rem;
          cursor: pointer;
          border-radius: 100px;
          transition: all 0.15s;
          letter-spacing: 0.05em;
        }
        .pill:hover { border-color: #1a6ef5; color: #1a6ef5; }

        /* ── Messages ────────────────────────────────────────────────────── */
        .message-row { display: flex; }
        .message-row.user { justify-content: flex-end; }
        .message-row.assistant { justify-content: flex-start; }
        .message-bubble {
          max-width: 85%;
          background: #0d1117;
          border: 1px solid #1e2530;
          border-radius: 6px;
          padding: 1rem 1.25rem;
        }
        .message-row.user .message-bubble { border-color: #1a3a6e; background: #0d1829; }
        .message-role {
          display: block;
          font-size: 0.58rem;
          letter-spacing: 0.18em;
          color: #4a5568;
          margin-bottom: 0.5rem;
        }
        .message-row.user .message-role { color: #1a6ef5; }

        /* Markdown table styling */
        :global(.message-content table) {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.75rem;
          margin-top: 0.5rem;
        }
        :global(.message-content th) {
          background: #111827;
          color: #1a6ef5;
          text-align: left;
          padding: 0.5rem 0.75rem;
          font-size: 0.65rem;
          letter-spacing: 0.1em;
          border-bottom: 1px solid #1e2530;
        }
        :global(.message-content td) {
          padding: 0.6rem 0.75rem;
          border-bottom: 1px solid #1e2530;
          color: #c8d0dc;
          line-height: 1.5;
          vertical-align: top;
        }
        :global(.message-content tr:last-child td) { border-bottom: none; }
        :global(.message-content p) { font-size: 0.8rem; line-height: 1.7; }
        :global(.message-content code) {
          background: #111827;
          padding: 0.1rem 0.3rem;
          border-radius: 3px;
          font-size: 0.75em;
        }

        /* Typing indicator */
        .loading { opacity: 0.7; }
        .typing-indicator { display: flex; gap: 4px; align-items: center; height: 20px; }
        .typing-indicator span {
          width: 5px; height: 5px;
          background: #1a6ef5;
          border-radius: 50%;
          animation: blink 1.2s infinite;
        }
        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes blink {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.9); }
          40% { opacity: 1; transform: scale(1); }
        }

        /* ── Input Area ──────────────────────────────────────────────────── */
        .input-form {
          display: flex;
          gap: 0.5rem;
          padding: 1rem 2rem;
          border-top: 1px solid #1e2530;
          background: #0d1117;
        }
        .chat-input {
          flex: 1;
          background: #0a0c10;
          border: 1px solid #1e2530;
          border-radius: 4px;
          color: #c8d0dc;
          font-family: inherit;
          font-size: 0.8rem;
          padding: 0.75rem 1rem;
        }
        .chat-input:focus { outline: none; border-color: #1a6ef5; }
        .chat-input::placeholder { color: #2d3748; }
        .send-btn {
          background: #1a6ef5;
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
        .send-btn:hover:not(:disabled) { background: #1557cc; }
        .send-btn:disabled { background: #1e2530; cursor: not-allowed; }

        /* ── Footer Disclaimer ───────────────────────────────────────────── */
        .disclaimer {
          text-align: center;
          font-size: 0.6rem;
          color: #2d3748;
          padding: 0.5rem 2rem 0.75rem;
          letter-spacing: 0.05em;
        }

        /* ── Error ───────────────────────────────────────────────────────── */
        .error-banner {
          background: rgba(220, 38, 38, 0.1);
          border: 1px solid rgba(220, 38, 38, 0.3);
          color: #fc8181;
          padding: 0.75rem 1rem;
          border-radius: 4px;
          font-size: 0.75rem;
        }
      `}</style>
    </div>
  );
}
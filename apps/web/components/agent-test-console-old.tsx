"use client";

import { useMemo, useRef, useEffect, useState } from "react";

type AdviceResponse = {
  ok: boolean;
  error?: string;
  details?: string;
  reply?: string;
  unresolved?: string;
  advice?: {
    symbol: string;
    side: "LONG" | "SHORT";
    market: "spot" | "perp";
    analyzedAt: string;
    currentPrice: number;
    support: number;
    resistance: number;
    entryZoneLow: number;
    entryZoneHigh: number;
    stopLoss: number;
    action: "WAIT" | "ENTER_ON_RETEST" | "INVALID_SETUP";
    entryTimeframe: "15m" | "1h" | "4h";
    setupType: "TREND_TRADE" | "COUNTER_TREND_BOUNCE" | "CHOP";
    trendlineStack: Array<{ timeframe: string; breakout: boolean; breakdown: boolean }>;
    trigger: string;
    invalidation: string;
    takeProfits: number[];
    confidence: number;
    timeframeSummary: string[];
    rationale: string[];
  };
  comparison?: {
    mode: string;
    recommendedSide: "LONG" | "SHORT" | "WAIT";
    long: AdviceResponse["advice"] | null;
    short: AdviceResponse["advice"] | null;
  };
};

type Message = {
  id: string;
  role: "user" | "ai";
  content: string;
  response?: AdviceResponse;
  isLoading?: boolean;
};

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(6);
}

export function AgentTestConsole() {
  const [message, setMessage] = useState("Should I long or short ETH right now?");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamedReply, setStreamedReply] = useState("");
  const [response, setResponse] = useState<AdviceResponse | null>(null);

  const endpoint = useMemo(() => `${API_BASE}/api/agent/trade-advice`, []);
  const streamEndpoint = useMemo(() => `${API_BASE}/api/agent/trade-advice/stream`, []);

  const runTest = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      setError("Message is required.");
      return;
    }
    if (trimmedMessage.length < 5) {
      setError("Message must be at least 5 characters.");
      return;
    }

    setLoading(true);
    setError(null);
    setStreamedReply("");
    setResponse(null);

    try {
      const res = await fetch(streamEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: trimmedMessage
        })
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as AdviceResponse | null;
        const serverError = data?.error ?? data?.unresolved ?? data?.reply ?? `Request failed (${res.status}).`;
        setError(serverError);
        if (data) {
          setResponse(data);
        }
        return;
      }

      if (!res.body) {
        throw new Error("Stream unavailable in this browser/runtime.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) {
            break;
          }

          const packet = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const lines = packet.split("\n");
          let eventName = "message";
          let dataString = "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataString += line.slice(5).trim();
            }
          }

          if (!dataString) {
            continue;
          }

          let payload: any = null;
          try {
            payload = JSON.parse(dataString);
          } catch {
            continue;
          }

          if (eventName === "delta") {
            setStreamedReply((prev) => `${prev}${String(payload?.text ?? "")}`);
            continue;
          }

          if (eventName === "error") {
            setError(String(payload?.error ?? "Streaming error"));
            continue;
          }

          if (eventName === "final") {
            setResponse(payload as AdviceResponse);
            if (typeof payload?.reply === "string") {
              setStreamedReply(payload.reply);
            }
          }
        }
      }
    } catch (requestError) {
      const msg = requestError instanceof Error ? requestError.message : "Unknown request error";
      setError(msg);
      setResponse(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 md:px-6">
      <div className="rounded-2xl border border-white/10 bg-[#0B1220]/90 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
        <h1 className="text-xl font-semibold text-[#E6EDF3]">AI Agent Test Console</h1>
        <p className="mt-1 text-sm text-[#9FB3C8]">
          Send prompts directly to the local advisor API and inspect both the narrative reply and structured payload.
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Ask naturally: Should I long or short ETH right now with current price?"
            className="w-full rounded-lg border border-white/10 bg-[#111B2E] px-3 py-2 text-sm text-[#E6EDF3] placeholder:text-[#6F829A] outline-none focus:border-[#4EA1FF]/60"
          />

          <button
            type="button"
            onClick={runTest}
            disabled={loading}
            className="rounded-lg bg-[#1F6FEB] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#388BFD] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Streaming..." : "Run Test"}
          </button>
        </div>

        <p className="mt-3 text-xs text-[#7E93AB]">Endpoint: {streamEndpoint}</p>
        <p className="mt-1 text-xs text-[#7E93AB]">Prompt tip: ask naturally; market is auto-selected from available data.</p>

        {error ? (
          <div className="mt-3 rounded-lg border border-[#EF4444]/35 bg-[#3F1218]/30 px-3 py-2 text-sm text-[#FCA5A5]">
            {error}
          </div>
        ) : null}
      </div>

      {response ? (
        <div className="grid gap-4">
          <div className="rounded-2xl border border-white/10 bg-[#0B1220]/90 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#9FB3C8]">Narrative Reply</h2>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#E6EDF3]">
              {streamedReply || response.reply || response.unresolved || "No reply text returned."}
            </p>

            {response.advice ? (
              <div className="mt-4 space-y-2 text-xs text-[#C7D6E7]">
                <p>
                  <span className="text-[#9FB3C8]">Symbol:</span> {response.advice.symbol} ({response.advice.market})
                </p>
                <p>
                  <span className="text-[#9FB3C8]">Live Price:</span> {formatPrice(response.advice.currentPrice)}
                </p>
                <p>
                  <span className="text-[#9FB3C8]">Side / Setup:</span> {response.advice.side} / {response.advice.setupType}
                </p>
                <p>
                  <span className="text-[#9FB3C8]">Action:</span> {response.advice.action} ({response.advice.entryTimeframe})
                </p>
                <p>
                  <span className="text-[#9FB3C8]">Entry Zone:</span> {formatPrice(response.advice.entryZoneLow)} - {formatPrice(response.advice.entryZoneHigh)}
                </p>
                <p>
                  <span className="text-[#9FB3C8]">Stop:</span> {formatPrice(response.advice.stopLoss)}
                </p>
                <p>
                  <span className="text-[#9FB3C8]">Targets:</span> {response.advice.takeProfits.map((tp) => formatPrice(tp)).join(", ")}
                </p>
                <p>
                  <span className="text-[#9FB3C8]">Support/Resistance:</span> {formatPrice(response.advice.support)} / {formatPrice(response.advice.resistance)}
                </p>
                <p>
                  <span className="text-[#9FB3C8]">Confidence:</span> {response.advice.confidence}%
                </p>
              </div>
            ) : null}
          </div>

          {response.comparison ? (
            <div className="rounded-2xl border border-white/10 bg-[#0B1220]/90 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#9FB3C8]">Long vs Short Comparison</h2>
              <p className="mt-2 text-xs text-[#C7D6E7]">
                Recommended side: <span className="font-semibold text-[#E6EDF3]">{response.comparison.recommendedSide}</span>
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-white/10 bg-[#0A111D] p-3 text-xs text-[#C7D6E7]">
                  <p className="font-semibold text-[#E6EDF3]">LONG</p>
                  <p className="mt-1">Action: {response.comparison.long?.action ?? "n/a"}</p>
                  <p>Confidence: {response.comparison.long?.confidence ?? "n/a"}%</p>
                  <p>TF: {response.comparison.long?.entryTimeframe ?? "n/a"}</p>
                  <p>Entry: {response.comparison.long ? `${formatPrice(response.comparison.long.entryZoneLow)} - ${formatPrice(response.comparison.long.entryZoneHigh)}` : "n/a"}</p>
                  <p>Stop: {response.comparison.long ? formatPrice(response.comparison.long.stopLoss) : "n/a"}</p>
                  <p>TPs: {response.comparison.long?.takeProfits?.map((tp) => formatPrice(tp)).join(", ") ?? "n/a"}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-[#0A111D] p-3 text-xs text-[#C7D6E7]">
                  <p className="font-semibold text-[#E6EDF3]">SHORT</p>
                  <p className="mt-1">Action: {response.comparison.short?.action ?? "n/a"}</p>
                  <p>Confidence: {response.comparison.short?.confidence ?? "n/a"}%</p>
                  <p>TF: {response.comparison.short?.entryTimeframe ?? "n/a"}</p>
                  <p>Entry: {response.comparison.short ? `${formatPrice(response.comparison.short.entryZoneLow)} - ${formatPrice(response.comparison.short.entryZoneHigh)}` : "n/a"}</p>
                  <p>Stop: {response.comparison.short ? formatPrice(response.comparison.short.stopLoss) : "n/a"}</p>
                  <p>TPs: {response.comparison.short?.takeProfits?.map((tp) => formatPrice(tp)).join(", ") ?? "n/a"}</p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {loading && !response ? (
        <div className="rounded-2xl border border-white/10 bg-[#0B1220]/90 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#9FB3C8]">Streaming Output</h2>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#E6EDF3]">{streamedReply || "Analyzing and preparing response..."}</p>
        </div>
      ) : null}
    </div>
  );
}

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

function PlainEnglishSummary({ response }: { response: AdviceResponse }) {
  const longAdvice = response.comparison?.long ?? (response.advice?.side === "LONG" ? response.advice : null);
  const shortAdvice = response.comparison?.short ?? (response.advice?.side === "SHORT" ? response.advice : null);

  const spotBuyReady = Boolean(
    longAdvice
      && longAdvice.action !== "WAIT"
      && response.comparison?.recommendedSide !== "SHORT"
  );
  const spotTone = spotBuyReady
    ? "border-green-500/35 bg-green-500/10 text-green-200"
    : "border-yellow-500/35 bg-yellow-500/10 text-yellow-200";

  const perpDecision: "WAIT" | "LONG" | "SHORT" = response.comparison
    ? response.comparison.recommendedSide
    : response.advice
      ? (response.advice.action === "WAIT" ? "WAIT" : response.advice.side)
      : "WAIT";

  const perpAdvice = perpDecision === "LONG"
    ? longAdvice
    : perpDecision === "SHORT"
      ? shortAdvice
      : (longAdvice ?? shortAdvice);

  const perpTone = perpDecision === "LONG"
    ? "border-green-500/35 bg-green-500/10 text-green-200"
    : perpDecision === "SHORT"
      ? "border-red-500/35 bg-red-500/10 text-red-200"
      : "border-yellow-500/35 bg-yellow-500/10 text-yellow-200";

  const spotTargets = longAdvice?.takeProfits?.slice(0, 3).map((tp) => formatPrice(tp)).join(" / ") || "Will appear when buy setup is ready";
  const perpTargets = perpAdvice?.takeProfits?.slice(0, 3).map((tp) => formatPrice(tp)).join(" / ") || "Wait for setup";

  const headline = spotBuyReady
    ? "You can buy spot now"
    : "Do not buy spot yet";
  const headlineTone = spotBuyReady
    ? "border-green-500/35 bg-green-500/10 text-green-200"
    : "border-yellow-500/35 bg-yellow-500/10 text-yellow-200";

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-widest text-white/60">How I Would Play It</p>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${headlineTone}`}>
          {headline}
        </span>
      </div>

      <div className="mt-3 space-y-2 text-sm text-white/90">
        <div className={`rounded-lg border p-3 ${spotTone}`}>
          <p className="text-xs uppercase tracking-widest">Spot (Buy and hold)</p>
          <p className="mt-2">Right now: <span className="font-semibold">{spotBuyReady ? "BUY" : "WAIT"}</span></p>
          <p>Buy zone: <span className="font-semibold text-[#4EA1FF]">{longAdvice ? `${formatPrice(longAdvice.entryZoneLow)} to ${formatPrice(longAdvice.entryZoneHigh)}` : "Not ready yet"}</span></p>
          <p>If wrong, cut at: <span className="font-semibold text-[#FF6B6B]">{longAdvice ? formatPrice(longAdvice.stopLoss) : "Not ready yet"}</span></p>
          <p>Take profit around: <span className="font-semibold text-[#51CF66]">{spotTargets}</span></p>
        </div>

        <div className={`rounded-lg border p-3 ${perpTone}`}>
          <p className="text-xs uppercase tracking-widest">Perp idea (if trading futures)</p>
          <p className="mt-2">Direction: <span className="font-semibold">{perpDecision === "WAIT" ? "WAIT" : perpDecision}</span></p>
          <p>Entry zone: <span className="font-semibold text-[#4EA1FF]">{perpAdvice ? `${formatPrice(perpAdvice.entryZoneLow)} to ${formatPrice(perpAdvice.entryZoneHigh)}` : "Not ready yet"}</span></p>
          <p>If wrong, cut at: <span className="font-semibold text-[#FF6B6B]">{perpAdvice ? formatPrice(perpAdvice.stopLoss) : "Not ready yet"}</span></p>
          <p>Take profit around: <span className="font-semibold text-[#51CF66]">{perpTargets}</span></p>
        </div>

        <p className="text-xs text-white/70">How strong this setup looks: <span className="font-semibold text-white">{(perpAdvice ?? longAdvice)?.confidence ?? response.advice?.confidence ?? 0}%</span></p>
      </div>
    </div>
  );
}

function UserMessageBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-xs rounded-2xl bg-[#1F6FEB] px-4 py-2.5 text-sm text-white">
        {content}
      </div>
    </div>
  );
}

function AIResponseBlock({ content, response, isLoading }: { content: string; response?: AdviceResponse; isLoading?: boolean }) {
  if (isLoading && !response) {
    return (
      <div className="flex justify-start">
        <div className="max-w-md rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
          Analyzing market context...
        </div>
      </div>
    );
  }

  if (!response) {
    if (!content.trim()) {
      return null;
    }

    return (
      <div className="flex justify-start">
        <div className="max-w-2xl rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85 whitespace-pre-wrap">
          {content}
        </div>
      </div>
    );
  }

  if (!response.ok || !response.advice) {
    return (
      <div className="flex justify-start">
        <div className="max-w-md rounded-2xl bg-white/10 px-4 py-3 text-sm text-red-300 border border-red-500/20">
          {response.error || response.unresolved || "Unable to analyze request."}
        </div>
      </div>
    );
  }

  const conversationalReply = (content || response.reply || "").trim();

  return (
    <div className="space-y-3">
      {conversationalReply ? (
        <div className="flex justify-start">
          <div className="max-w-2xl rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/85 whitespace-pre-wrap">
            {conversationalReply}
          </div>
        </div>
      ) : null}
      <div className="flex justify-start">
        <div className="w-full max-w-2xl space-y-3">
          <PlainEnglishSummary response={response} />
        </div>
      </div>
    </div>
  );
}

export function AgentTestConsole() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("Should I long or short ETH?");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const streamEndpoint = useMemo(() => `${API_BASE}/api/agent/trade-advice/stream`, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length < 5) {
      return;
    }

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed
    };

    const aiMessageId = `ai-${Date.now()}`;

    setMessages((prev) => [
      ...prev,
      userMessage,
      {
        id: aiMessageId,
        role: "ai",
        content: "",
        isLoading: true,
      },
    ]);
    setLoading(true);
    setInputValue("");

    try {
      const res = await fetch(streamEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed })
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as AdviceResponse | null;
        const errorText = data?.details || data?.error || data?.unresolved || "Unable to process request.";
        setMessages((prev) => prev.map((msg) => (
          msg.id === aiMessageId
            ? { ...msg, content: errorText, response: data ?? { ok: false, error: errorText, details: errorText }, isLoading: false }
            : msg
        )));
        return;
      }

      if (!res.body) {
        const errorText = "Streaming is unavailable on this server.";
        setMessages((prev) => prev.map((msg) => (
          msg.id === aiMessageId
            ? { ...msg, content: errorText, response: { ok: false, error: errorText }, isLoading: false }
            : msg
        )));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalPayload: AdviceResponse | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;

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

          if (!dataString) continue;

          let payload: any = null;
          try {
            payload = JSON.parse(dataString);
          } catch {
            continue;
          }

          if (eventName === "delta") {
            const chunk = String(payload?.text ?? "");
            if (!chunk) continue;
            setMessages((prev) => prev.map((msg) => (
              msg.id === aiMessageId
                ? { ...msg, content: `${msg.content}${chunk}` }
                : msg
            )));
            continue;
          }

          if (eventName === "error") {
            const errorText = String(payload?.error ?? "Streaming error");
            setMessages((prev) => prev.map((msg) => (
              msg.id === aiMessageId
                ? { ...msg, content: errorText, response: { ok: false, error: errorText, details: errorText }, isLoading: false }
                : msg
            )));
            continue;
          }

          if (eventName === "final") {
            finalPayload = payload as AdviceResponse;
            setMessages((prev) => prev.map((msg) => (
              msg.id === aiMessageId
                ? {
                    ...msg,
                    content: typeof payload?.reply === "string" && payload.reply.length > 0 ? payload.reply : msg.content,
                    response: payload as AdviceResponse,
                    isLoading: false,
                  }
                : msg
            )));
          }
        }
      }

      if (!finalPayload) {
        setMessages((prev) => prev.map((msg) => (
          msg.id === aiMessageId ? { ...msg, isLoading: false } : msg
        )));
      }
    } catch (err) {
      const errorText = err instanceof Error ? err.message : "Connection error. Please try again.";
      setMessages((prev) => prev.map((msg) => (
        msg.id === aiMessageId
          ? { ...msg, content: errorText, response: { ok: false, error: errorText }, isLoading: false }
          : msg
      )));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0B0F1A]">
      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-5 pt-6 pb-4">
          {messages.length === 0 ? (
            <div className="flex min-h-[220px] flex-col justify-start pt-6">
              <div className="mt-2 flex flex-wrap gap-3">
                {[
                  "Should I long or short ETH?",
                  "Best entry for BTC right now?",
                  "Is this a good time to buy SOL?"
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => {
                      setInputValue(prompt);
                      setTimeout(() => {
                        const input = document.querySelector('input[type="text"]') as HTMLInputElement;
                        input?.focus();
                      }, 0);
                    }}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white transition"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <div key={msg.id} className="animate-fade-in">
                  {msg.role === "user" ? (
                    <UserMessageBubble content={msg.content} />
                  ) : (
                    <AIResponseBlock content={msg.content} response={msg.response} isLoading={msg.isLoading} />
                  )}
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="max-w-md space-y-2">
                    <div className="h-12 w-32 animate-pulse rounded-lg bg-white/10"></div>
                    <div className="h-20 w-64 animate-pulse rounded-lg bg-white/10"></div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </div>

      {/* Input Bar */}
      <div className="border-t border-white/10 bg-gradient-to-t from-white/5 to-transparent px-5 py-3.5 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl gap-3">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything about the market..."
            disabled={loading}
            className="flex-1 rounded-full border border-white/10 bg-white/5 px-5 py-3.5 text-sm text-white placeholder:text-white/40 focus:border-[#4EA1FF]/50 focus:bg-white/10 focus:outline-none transition disabled:opacity-50"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !inputValue.trim()}
            className="flex items-center justify-center rounded-full bg-[#1F6FEB] px-4 py-3.5 text-white hover:bg-[#2A7DFF] disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M16.293 2.707a1 1 0 00-1.414 0L2 15.586V18a1 1 0 001 1h2.414L16.293 4.12a1 1 0 000-1.414z" />
            </svg>
          </button>
        </div>
      </div>

      <style jsx>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}

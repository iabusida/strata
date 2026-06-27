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

function DecisionCard({ advice }: { advice: AdviceResponse["advice"] }) {
  if (!advice) return null;

  const actionColor =
    advice.action === "WAIT"
      ? "bg-yellow-500/20 border-yellow-500/40 text-yellow-300"
      : advice.side === "LONG"
        ? "bg-green-500/20 border-green-500/40 text-green-300"
        : "bg-red-500/20 border-red-500/40 text-red-300";

  const actionEmoji = advice.action === "WAIT" ? "⏳" : advice.side === "LONG" ? "📈" : "📉";

  return (
    <div className={`rounded-xl border p-4 ${actionColor}`}>
      <p className="text-xs uppercase tracking-widest text-white/60">Decision</p>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <p className="text-lg font-semibold text-white">{actionEmoji} {advice.action === "WAIT" ? "WAIT" : advice.side}</p>
          <p className="mt-1 text-xs text-white/70">{formatPrice(advice.currentPrice)} • {advice.entryTimeframe}</p>
        </div>
        <p className="text-sm font-bold text-white">{advice.confidence}%</p>
      </div>
      <p className="mt-2 text-xs text-white/70">
        {advice.setupType.replace(/_/g, " ").toLowerCase()}
      </p>
    </div>
  );
}

function PlanCard({ advice }: { advice: AdviceResponse["advice"] }) {
  if (!advice) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-widest text-white/60">Trade Plan</p>
      <div className="mt-3 grid gap-3 text-sm">
        <div>
          <p className="text-white/50">Entry Zone</p>
          <p className="font-mono text-base font-bold text-[#4EA1FF]">
            {formatPrice(advice.entryZoneLow)} – {formatPrice(advice.entryZoneHigh)}
          </p>
        </div>
        <div>
          <p className="text-white/50">Stop Loss</p>
          <p className="font-mono text-base font-bold text-[#FF6B6B]">{formatPrice(advice.stopLoss)}</p>
        </div>
        <div>
          <p className="text-white/50">Targets</p>
          <div className="mt-1 space-y-1 font-mono">
            {advice.takeProfits.map((tp, i) => (
              <p key={i} className="text-sm font-bold text-[#51CF66]">
                TP{i + 1}: {formatPrice(tp)}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExplanationBlock({ advice }: { advice: AdviceResponse["advice"] }) {
  if (!advice) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="text-sm leading-relaxed text-white/90">{advice.rationale?.[0] ?? "Analysis complete."}</p>
    </div>
  );
}

function AdvancedDetailsToggle({ advice }: { advice: AdviceResponse["advice"] }) {
  const [open, setOpen] = useState(false);

  if (!advice) return null;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-white/50 hover:text-white/70 transition"
      >
        {open ? "Hide" : "Show"} advanced details
      </button>
      {open && (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs space-y-2 text-white/60">
          <div className="font-mono">
            <p>Timeframe Analysis:</p>
            {advice.timeframeSummary?.slice(0, 3).map((line, i) => (
              <p key={i} className="text-white/50">{line}</p>
            ))}
          </div>
          <div>
            <p>Support: {formatPrice(advice.support)}</p>
            <p>Resistance: {formatPrice(advice.resistance)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function LongVsShortTabs({ comparison }: { comparison: AdviceResponse["comparison"] }) {
  const [activeTab, setActiveTab] = useState<"long" | "short">("long");

  if (!comparison?.long || !comparison?.short) return null;

  const active = activeTab === "long" ? comparison.long : comparison.short;

  return (
    <div className="space-y-3">
      <div className="flex gap-2 rounded-lg border border-white/10 bg-white/5 p-1">
        {["long", "short"].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab as "long" | "short")}
            className={`flex-1 rounded-md py-2 px-3 text-xs font-semibold transition ${
              activeTab === tab
                ? "bg-white/10 text-white"
                : "text-white/50 hover:text-white/70"
            }`}
          >
            {tab === "long" ? "📈 LONG" : "📉 SHORT"}
          </button>
        ))}
      </div>
      <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
        <div>
          <p className="text-xs text-white/50 uppercase tracking-widest">Action</p>
          <p className="mt-1 text-sm font-bold text-white">{active?.action}</p>
        </div>
        <div>
          <p className="text-xs text-white/50 uppercase tracking-widest">Confidence</p>
          <p className="mt-1 text-sm font-bold text-white">{active?.confidence}%</p>
        </div>
        <div>
          <p className="text-xs text-white/50 uppercase tracking-widest">Entry Zone</p>
          <p className="mt-1 font-mono text-sm font-bold text-[#4EA1FF]">
            {formatPrice(active?.entryZoneLow ?? 0)} – {formatPrice(active?.entryZoneHigh ?? 0)}
          </p>
        </div>
        <div>
          <p className="text-xs text-white/50 uppercase tracking-widest">Stop</p>
          <p className="mt-1 font-mono text-sm font-bold text-[#FF6B6B]">
            {formatPrice(active?.stopLoss ?? 0)}
          </p>
        </div>
        <div>
          <p className="text-xs text-white/50 uppercase tracking-widest">Targets</p>
          <div className="mt-1 space-y-1 font-mono">
            {active?.takeProfits?.map((tp, i) => (
              <p key={i} className="text-xs font-bold text-[#51CF66]">
                TP{i + 1}: {formatPrice(tp)}
              </p>
            ))}
          </div>
        </div>
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

function AIResponseBlock({ response }: { response: AdviceResponse }) {
  if (!response.ok || !response.advice) {
    return (
      <div className="flex justify-start">
        <div className="max-w-md rounded-2xl bg-white/10 px-4 py-3 text-sm text-red-300 border border-red-500/20">
          {response.error || response.unresolved || "Unable to analyze request."}
        </div>
      </div>
    );
  }

  const isComparison = response.comparison?.long && response.comparison?.short;

  return (
    <div className="space-y-3">
      <div className="flex justify-start">
        <div className="w-full max-w-2xl space-y-3">
          {isComparison ? (
            <LongVsShortTabs comparison={response.comparison} />
          ) : (
            <>
              <DecisionCard advice={response.advice} />
              <PlanCard advice={response.advice} />
              <ExplanationBlock advice={response.advice} />
            </>
          )}
          <AdvancedDetailsToggle advice={response.advice} />
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

  const endpoint = useMemo(() => `${API_BASE}/api/agent/trade-advice`, []);

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

    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);
    setInputValue("");

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed })
      });

      const data = (await res.json().catch(() => null)) as AdviceResponse | null;

      const aiMessage: Message = {
        id: `ai-${Date.now()}`,
        role: "ai",
        content: data?.reply || data?.error || "Unable to process request.",
        response: data ?? undefined
      };

      setMessages((prev) => [...prev, aiMessage]);
    } catch (err) {
      const aiMessage: Message = {
        id: `ai-${Date.now()}`,
        role: "ai",
        content: "Connection error. Please try again.",
        response: { ok: false, error: "Network error" }
      };
      setMessages((prev) => [...prev, aiMessage]);
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
                    <AIResponseBlock response={msg.response || { ok: false, error: msg.content }} />
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

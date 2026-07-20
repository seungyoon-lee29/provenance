"use client";

import { useEffect, useState } from "react";

// Minimal personal-quote widget (ticket 26-c). Consumes /api/market and renders a value ONLY on an
// available outcome (F1 discipline: no fabricated numbers); otherwise it shows provenance-free status.
type Outcome = Readonly<{
  status: "available" | "unavailable" | "failed";
  reason?: string;
  value?: Readonly<{ symbol: string; last: number; currency: string; change: number; changePercent: number; priceBasis: string }>;
  provider?: string;
  freshness?: string;
  asOf?: string;
}>;

export function MarketWidget({ initialSymbol = "005930" }: Readonly<{ initialSymbol?: string }>) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [query, setQuery] = useState(initialSymbol);
  // Tag each result with the query it answers so loading is DERIVED (no synchronous reset in the effect).
  const [result, setResult] = useState<{ forQuery: string; data: Outcome } | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void fetch(`/api/market?symbol=${encodeURIComponent(query)}`)
      .then((response) => (response.ok ? (response.json() as Promise<Outcome>) : ({ status: "failed" } as Outcome)))
      .then((data) => {
        if (active) setResult({ forQuery: query, data });
      })
      .catch(() => {
        if (active) setResult({ forQuery: query, data: { status: "failed" } });
      });
    return () => {
      active = false;
    };
  }, [query]);

  const outcome = result?.forQuery === query ? result.data : undefined;

  return (
    <section data-role="market-widget" style={{ marginBottom: "16px", padding: "12px", border: "1px solid #444", borderRadius: "8px" }}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 8px" }}>내 시세 (KIS)</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(symbol.trim());
        }}
        style={{ display: "flex", gap: "8px", marginBottom: "8px" }}
      >
        <input
          aria-label="종목코드"
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
          style={{ minHeight: "44px", flex: "0 0 8rem" }}
        />
        <button type="submit" style={{ minHeight: "44px" }}>
          조회
        </button>
      </form>

      {outcome === undefined ? (
        <p aria-live="polite">불러오는 중...</p>
      ) : outcome.status === "available" && outcome.value !== undefined ? (
        <div data-role="market-value">
          <p style={{ margin: "0 0 4px", fontSize: "1.25rem" }}>
            <span data-role="market-last">{outcome.value.last.toLocaleString()}</span> {outcome.value.currency}{" "}
            <span data-role="market-change">
              ({outcome.value.change >= 0 ? "+" : ""}
              {outcome.value.change.toLocaleString()} · {outcome.value.changePercent}%)
            </span>
          </p>
          <p style={{ margin: 0, fontSize: "0.8rem", opacity: 0.8 }}>
            <span data-role="market-freshness">{outcome.freshness}</span> · {outcome.value.priceBasis} ·{" "}
            {outcome.provider} · {outcome.asOf}
          </p>
        </div>
      ) : (
        <p data-role="market-unavailable">
          {outcome.status === "unavailable" ? `표시할 수 없음: ${outcome.reason ?? "no_data"}` : "일시적으로 불러올 수 없습니다."}
        </p>
      )}
    </section>
  );
}

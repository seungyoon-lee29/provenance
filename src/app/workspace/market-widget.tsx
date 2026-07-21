"use client";

import { useEffect, useState } from "react";

import type { MarketObservation } from "@/modules/financial-information/data/contracts";
import type { InformationOutcome } from "@/shared/contracts/information-outcome";

// Minimal personal-quote widget (ticket 26-c). Consumes /api/market and renders a value ONLY on an
// available outcome (F1 discipline: no fabricated numbers); otherwise it shows provenance-free status.
// The parsed body IS the backend contract type — so the compiler, not a hand-rolled shape, guarantees
// the widget and /api/market stay in sync (a `network_error` sentinel covers transport/non-2xx).
type MarketOutcome = InformationOutcome<MarketObservation>;

// 업종지수 행 (ticket 31-b): 같은 /api/market 계약 소비, available일 때만 값.
function IndexRow({ symbol, label }: Readonly<{ symbol: string; label: string }>) {
  const [outcome, setOutcome] = useState<MarketOutcome | "network_error" | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}`, {
          signal: AbortSignal.timeout(15_000),
        });
        const data: MarketOutcome | "network_error" = response.ok ? ((await response.json()) as MarketOutcome) : "network_error";
        if (active) setOutcome(data);
      } catch {
        if (active) setOutcome("network_error");
      }
    })();
    return () => {
      active = false;
    };
  }, [symbol]);

  return (
    <li data-role="index-row" data-symbol={symbol} style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
      <span>{label}</span>
      {outcome === undefined ? (
        <span aria-live="polite">확인 중</span>
      ) : outcome !== "network_error" && outcome.status === "available" ? (
        <strong data-role="index-value">
          {outcome.value.last.toLocaleString()}
          {outcome.value.currency === "pt" ? "" : outcome.value.currency} ({outcome.value.change >= 0 ? "+" : ""}
          {outcome.value.changePercent}%) · {outcome.freshness}
        </strong>
      ) : (
        <span data-role="index-unavailable">
          {outcome !== "network_error" && outcome.status === "unavailable" ? `표시할 수 없음: ${outcome.reason}` : "일시적으로 불러올 수 없음"}
        </span>
      )}
    </li>
  );
}

export function MarketWidget({ initialSymbol = "005930" }: Readonly<{ initialSymbol?: string }>) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [query, setQuery] = useState(initialSymbol);
  // Tag each result with the query it answers so loading is DERIVED (no synchronous reset in the effect).
  const [result, setResult] = useState<{ forQuery: string; data: MarketOutcome | "network_error" } | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/market?symbol=${encodeURIComponent(query)}`);
        const data: MarketOutcome | "network_error" = response.ok ? ((await response.json()) as MarketOutcome) : "network_error";
        if (active) setResult({ forQuery: query, data });
      } catch {
        if (active) setResult({ forQuery: query, data: "network_error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [query]);

  const outcome = result?.forQuery === query ? result.data : undefined;

  return (
    <section data-role="market-widget" style={{ marginBottom: "16px", padding: "12px", border: "1px solid #444", borderRadius: "8px" }}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 8px" }}>내 시세 (KIS)</h2>
      <ul aria-label="국내 업종지수" style={{ listStyle: "none", margin: "0 0 12px", padding: 0 }}>
        <IndexRow symbol="KOSPI" label="코스피" />
        <IndexRow symbol="KOSDAQ" label="코스닥" />
      </ul>
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
      ) : outcome === "network_error" ? (
        <p data-role="market-unavailable">일시적으로 불러올 수 없습니다.</p>
      ) : outcome.status === "available" ? (
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
      ) : outcome.status === "unavailable" ? (
        <p data-role="market-unavailable">표시할 수 없음: {outcome.reason}</p>
      ) : (
        <p data-role="market-unavailable">일시적으로 불러올 수 없습니다.</p>
      )}
    </section>
  );
}

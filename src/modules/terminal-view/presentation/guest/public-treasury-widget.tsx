"use client";

import { useEffect, useState } from "react";

import type { MarketObservation } from "@/modules/financial-information/data/contracts";
import type { InformationOutcome } from "@/shared/contracts/information-outcome";

// Public treasury rows (ticket 28-c). Consumes /api/public-market and renders a value ONLY on an
// available outcome (F1 discipline: no fabricated numbers); otherwise a provenance-free status.
// The parsed body IS the backend contract type — the compiler keeps widget and route in sync
// (a `network_error` sentinel covers transport/non-2xx), same pattern as the personal market-widget.
type MarketOutcome = InformationOutcome<MarketObservation>;

const SYMBOLS = [
  { symbol: "UST2Y", label: "미국 국채 2Y" },
  { symbol: "UST10Y", label: "미국 국채 10Y" },
] as const;

const freshnessLabels: Readonly<Record<string, string>> = {
  realtime: "최신",
  delayed: "지연",
  stale: "오래됨",
};

function TreasuryRow({ symbol, label }: Readonly<{ symbol: string; label: string }>) {
  const [outcome, setOutcome] = useState<MarketOutcome | "network_error" | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Client-side deadline: the route self-guarantees a 10s outcome, but a hung connection
        // would otherwise leave "확인 중" forever (acceptance: no infinite spinner).
        const response = await fetch(`/api/public-market?symbol=${encodeURIComponent(symbol)}`, {
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
    <li data-role="treasury-row" data-symbol={symbol} style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
      <span>{label}</span>
      {outcome === undefined ? (
        <span aria-live="polite">확인 중</span>
      ) : outcome === "network_error" ? (
        <span data-role="treasury-unavailable">일시적으로 불러올 수 없음</span>
      ) : outcome.status === "available" ? (
        <strong data-role="treasury-value">
          {outcome.value.last}
          {outcome.value.currency} · {freshnessLabels[outcome.freshness] ?? outcome.freshness} ·{" "}
          {outcome.asOf.slice(0, 10)}
        </strong>
      ) : outcome.status === "unavailable" ? (
        <span data-role="treasury-unavailable">표시할 수 없음: {outcome.reason}</span>
      ) : (
        <span data-role="treasury-unavailable">일시적으로 불러올 수 없음</span>
      )}
    </li>
  );
}

export function PublicTreasuryWidget() {
  return (
    <ul data-role="public-treasury" aria-label="미 재무부 수익률 곡선" style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
      {SYMBOLS.map(({ symbol, label }) => (
        <TreasuryRow key={symbol} symbol={symbol} label={label} />
      ))}
    </ul>
  );
}

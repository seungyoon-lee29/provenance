"use client";

import { useEffect, useState } from "react";

import type { MarketObservation } from "@/modules/financial-information/data/contracts";
import type { InformationOutcome } from "@/shared/contracts/information-outcome";

import styles from "./guest-terminal-shell.module.css";

// Public market rows (tickets 28-c, 32-c). Consumes /api/public-market and renders a value ONLY on
// an available outcome (F1 discipline: no fabricated numbers); otherwise a provenance-free status.
// The parsed body IS the backend contract type — the compiler keeps widget and route in sync
// (a `network_error` sentinel covers transport/non-2xx), same pattern as the personal market-widget.
// Typography rides the shell's microList system class — no bespoke sizes.
type MarketOutcome = InformationOutcome<MarketObservation>;

const SYMBOLS = [
  { symbol: "UST2Y", label: "미국 국채 2Y" },
  { symbol: "UST10Y", label: "미국 국채 10Y" },
  { symbol: "USDKRW", label: "달러/원 (ECB 교차)" },
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
    <li data-role="treasury-row" data-symbol={symbol}>
      <span>{label}</span>
      {outcome === undefined ? (
        <strong aria-live="polite">확인 중</strong>
      ) : outcome === "network_error" ? (
        <strong data-role="treasury-unavailable">일시적으로 불러올 수 없음</strong>
      ) : outcome.status === "available" ? (
        <strong data-role="treasury-value">
          {Math.round(outcome.value.last * 100) / 100}
          {outcome.value.currency} · {freshnessLabels[outcome.freshness] ?? outcome.freshness} ·{" "}
          {outcome.asOf.slice(0, 10)}
        </strong>
      ) : outcome.status === "unavailable" ? (
        <strong data-role="treasury-unavailable">표시할 수 없음: {outcome.reason}</strong>
      ) : (
        <strong data-role="treasury-unavailable">일시적으로 불러올 수 없음</strong>
      )}
    </li>
  );
}

export function PublicTreasuryWidget() {
  return (
    <ul data-role="public-treasury" aria-label="공개 시장 데이터 (재무부·ECB)" className={styles.microList}>
      {SYMBOLS.map(({ symbol, label }) => (
        <TreasuryRow key={symbol} symbol={symbol} label={label} />
      ))}
    </ul>
  );
}

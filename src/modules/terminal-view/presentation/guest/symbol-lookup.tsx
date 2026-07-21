"use client";

import { useEffect, useRef, useState } from "react";

import type { MarketObservation } from "@/modules/financial-information/data/contracts";
import type { InformationOutcome } from "@/shared/contracts/information-outcome";

import styles from "./guest-terminal-shell.module.css";

// 명령창 조회 결과 (ticket 37). `/api/market` 계약 타입을 그대로 소비해 프론트↔백엔드 일치를
// 컴파일러가 강제한다(다른 위젯과 같은 규칙). 값은 available일 때만 — F1 불변식.
type MarketOutcome = InformationOutcome<MarketObservation>;
type LookupResult = MarketOutcome | "network_error";

const freshnessLabels: Readonly<Record<string, string>> = {
  realtime: "실시간",
  delayed: "지연",
  stale: "오래됨",
};

function unavailableCopy(outcome: MarketOutcome): string {
  if (outcome.status === "unavailable") {
    // 게스트에게 개인 시세는 라이선스상 닫혀 있다 — "없다"가 아니라 "로그인이 필요하다"가 사실이다.
    if (outcome.reason === "api_required") return "로그인 필요";
    // 공급자가 이 심볼에 대해 관측값을 주지 않았다(오타·상장폐지·미지원). 값을 지어내지 않는다.
    if (outcome.reason === "no_data") return "조회 결과 없음";
    return `표시할 수 없음: ${outcome.reason}`;
  }
  if (outcome.status === "failed") return `조회 실패: ${outcome.degradation.code}`;
  return "표시할 수 없음";
}

/** 조회 한 건을 한 줄로. 값이 없으면 값을 만들지 않고 이유를 적는다. */
function LookupLine({ symbol, outcome }: Readonly<{ symbol: string; outcome?: LookupResult }>) {
  return (
    <li data-role="lookup-row" data-symbol={symbol}>
      <span>{symbol}</span>
      {outcome === undefined ? (
        <strong aria-live="polite">확인 중</strong>
      ) : outcome === "network_error" ? (
        <strong data-role="lookup-unavailable">일시적으로 불러올 수 없음</strong>
      ) : outcome.status === "available" ? (
        <strong data-role="lookup-value">
          {outcome.value.last.toLocaleString()}
          {outcome.value.currency === "pt" ? "" : ` ${outcome.value.currency}`} ({outcome.value.change >= 0 ? "+" : ""}
          {outcome.value.changePercent}%) · {freshnessLabels[outcome.freshness] ?? outcome.freshness}
        </strong>
      ) : (
        <strong data-role="lookup-unavailable">{unavailableCopy(outcome)}</strong>
      )}
    </li>
  );
}

/**
 * 조회 목록. 명령창이 심볼을 넘기면 여기 쌓인다 — 검색과 관심목록이 같은 기계다(ticket 37).
 * 로그인 상태에서는 개인(KIS) 시세, 비로그인은 정직하게 "로그인 필요".
 *
 * 행은 `symbols`에서 파생하고 상태는 결과 맵 하나뿐이다 — effect 안에서 동기 setState를 하지 않아
 * 연쇄 렌더가 없다.
 */
export function SymbolLookup({ symbols }: Readonly<{ symbols: readonly string[] }>) {
  const [results, setResults] = useState<Readonly<Record<string, LookupResult>>>({});
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pending = symbols.filter((symbol) => !requested.current.has(symbol));
    if (pending.length === 0) return;
    pending.forEach((symbol) => requested.current.add(symbol));
    let active = true;
    void (async () => {
      // 순차 조회: 공급자 유량 게이트(티켓 34)가 어차피 직렬화하므로 동시에 던져도 이득이 없다.
      for (const symbol of pending) {
        let outcome: LookupResult;
        try {
          const response = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}`, {
            signal: AbortSignal.timeout(15_000),
          });
          outcome = response.ok ? ((await response.json()) as MarketOutcome) : "network_error";
        } catch {
          outcome = "network_error";
        }
        if (!active) return;
        setResults((current) => ({ ...current, [symbol]: outcome }));
      }
    })();
    return () => {
      active = false;
    };
  }, [symbols]);

  if (symbols.length === 0) return null;
  return (
    <ul data-role="symbol-lookup" aria-label="조회 결과" className={styles.microList}>
      {symbols.map((symbol) => (
        <LookupLine key={symbol} symbol={symbol} {...(results[symbol] ? { outcome: results[symbol] } : {})} />
      ))}
    </ul>
  );
}

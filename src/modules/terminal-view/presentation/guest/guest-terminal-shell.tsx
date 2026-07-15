"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { brandReference } from "../../../../shared/contracts/brands";

import type {
  GuestPanelState,
  GuestTerminalSnapshot,
  PublicPanelKey,
} from "./contracts";
import { GuestPanel, LoginGate } from "./guest-panel";
import styles from "./guest-terminal-shell.module.css";
import { useGuestPanelUpdates } from "./guest-update-client";

const panelTitles: Readonly<Record<PublicPanelKey, string>> = {
  "index-sp500": "S&P 500",
  "index-nasdaq": "NASDAQ",
  "index-kospi": "KOSPI",
  "index-usdkrw": "USD/KRW",
  "index-us10y": "미국 10Y",
  "market-overview": "시장 요약",
  watchlist: "관심종목",
  filings: "공시",
  "market-landscape": "시장 개요",
  headlines: "주요 뉴스",
  macro: "금리·환율·원자재",
  "data-quality": "데이터 품질",
};

function panelMap(panels: readonly GuestPanelState[]): ReadonlyMap<PublicPanelKey, GuestPanelState> {
  return new Map(panels.map((panel) => [panel.panelKey, panel]));
}

function fallbackPanel(panelKey: PublicPanelKey, requestRevision: string): GuestPanelState {
  return {
    panelKey,
    state: "ready",
    requestRevision,
    outcome: {
      status: "unavailable",
      reason: "api_required",
      requiredCapability: `public_${panelKey}`,
      configurationRoute: "/settings/providers",
      policyVersion: brandReference<string, "PolicyVersion">("policy:f1-public"),
    },
  };
}

function IndexCell({ state }: Readonly<{ state: GuestPanelState }>) {
  let label = "확인 중";
  let value: string | undefined;
  if (state.state === "pending") label = state.phase === "provider_wait" ? "공급자 응답 대기" : "데이터 확인 중";
  else if (state.outcome.status === "available") {
    label = state.outcome.freshness === "realtime" ? "실시간" : state.outcome.freshness === "delayed" ? "지연" : "오래됨";
    value = state.outcome.value.displayValue;
  } else if (state.outcome.status === "failed") label = state.outcome.degradation.retryable ? "재시도 가능" : "응답 오류";
  else if (state.outcome.reason === "api_required") label = "API 필요";
  else if (state.outcome.reason === "license_restricted") label = "표시 권한 없음";
  else label = "데이터 없음";
  return (
    <li data-panel-key={state.panelKey}>
      <span>{panelTitles[state.panelKey]}</span>
      {value ? (
        <strong data-role="primary-value" role="status" aria-live="polite" aria-atomic="true">{value}</strong>
      ) : (
        <strong role="status" aria-live="polite" aria-atomic="true">{label}</strong>
      )}
    </li>
  );
}

export function GuestTerminalShell({ snapshot, updateUrl }: Readonly<{
  snapshot: GuestTerminalSnapshot;
  updateUrl: string;
}>) {
  const panels = useGuestPanelUpdates(snapshot, updateUrl);
  const byKey = useMemo(() => panelMap(panels), [panels]);
  const get = (panelKey: PublicPanelKey) => byKey.get(panelKey) ?? fallbackPanel(panelKey, snapshot.requestRevision);
  const [menuOpen, setMenuOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("게스트 터미널 준비 완료");
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  function handleCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAnnouncement("명령 실행은 다음 단계에서 제공됩니다. 현재 화면은 읽기 전용입니다.");
  }

  return (
    <div className={styles.shell}>
      <header className={styles.globalHeader}>
        <a className={styles.brand} href="#workspace" aria-label="FB Terminal 홈">FB<span>:TERMINAL</span></a>
        <button
          ref={menuButtonRef}
          className={styles.menuButton}
          type="button"
          aria-label="주 메뉴"
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <nav
          id="primary-navigation"
          className={menuOpen ? styles.navOpen : undefined}
          aria-label="주 메뉴"
          onClick={() => setMenuOpen(false)}
        >
          <a href="#market">시장</a>
          <a href="#watchlist">관심종목</a>
          <a href="#headlines">뉴스·공시</a>
          <a href="#paper">Paper</a>
        </nav>
        <form className={styles.command} role="search" onSubmit={handleCommand}>
          <label htmlFor="terminal-command">명령 또는 티커 입력</label>
          <span aria-hidden="true">⌕</span>
          <input id="terminal-command" name="command" autoComplete="off" placeholder="명령 또는 티커 입력" />
          <kbd>⌘K</kbd>
          <button className={styles.commandSubmit} type="submit" aria-label="명령 실행">↵</button>
        </form>
        <button
          className={styles.aiButton}
          type="button"
          onClick={() => setAnnouncement("AI 분석은 로그인 후 사용할 수 있습니다.")}
        >
          AI <span>분석</span>
        </button>
      </header>

      {snapshot.syntheticMarker ? (
        <div className={styles.syntheticBanner} role="note">
          <strong>{snapshot.syntheticMarker}</strong>
          <span>INTERNAL TEST ONLY · 실제 시장 데이터 아님</span>
        </div>
      ) : null}

      <section className={styles.indexStrip} aria-label="시장 지수 스트립" tabIndex={0}>
        <ul>
          {(["index-sp500", "index-nasdaq", "index-kospi", "index-usdkrw", "index-us10y"] as const).map((key) => (
            <IndexCell key={key} state={get(key)} />
          ))}
        </ul>
      </section>

      <main id="workspace" className={styles.workspace} tabIndex={0} data-workspace="guest" aria-label="터미널 Workspace">
        <div id="market" className={`${styles.column} ${styles.leftColumn}`} aria-label="시장 모니터" tabIndex={0}>
          <GuestPanel title="시장 요약" state={get("market-overview")} className={styles.marketSummary}>
            <ul className={styles.microList} aria-label="시장 상태 요약">
              <li><span>공개 범위</span><strong>License 확인</strong></li>
              <li><span>갱신 경로</span><strong>독립 update</strong></li>
            </ul>
          </GuestPanel>
          <div id="watchlist">
            <GuestPanel title="관심종목" state={get("watchlist")} />
          </div>
          <GuestPanel title="공시" state={get("filings")} />
        </div>

        <div className={`${styles.column} ${styles.centerColumn}`} aria-label="공개 정보 Workspace" tabIndex={0}>
          <GuestPanel title="시장 개요" state={get("market-landscape")} className={styles.landscape}>
            <div className={styles.emptyPlot} aria-label="차트 상호작용은 F2에서 제공됩니다">
              <span>PUBLIC MARKET SURFACE</span>
              <strong>차트 상호작용 준비 중</strong>
              <small>F2 tracer가 이 구조적 영역을 사용합니다.</small>
            </div>
          </GuestPanel>
          <div id="headlines">
            <GuestPanel title="주요 뉴스" state={get("headlines")} />
          </div>
          <GuestPanel title="금리·환율·원자재" state={get("macro")} />
        </div>

        <aside className={`${styles.column} ${styles.rightColumn}`} aria-label="개인 기능과 데이터 품질" tabIndex={0}>
          <div id="paper"><LoginGate title="Paper Trading" feature="paper-trading" /></div>
          <LoginGate title="AI Assistant" feature="ai-assistant" />
          <GuestPanel title="데이터 품질" state={get("data-quality")} className={styles.qualityPanel} />
        </aside>

        <section className={`${styles.panel} ${styles.blotter}`} aria-labelledby="paper-blotter-title" data-access="login_required">
          <header className={styles.panelHeader}>
            <h2 id="paper-blotter-title">Paper Blotter</h2>
            <span className={styles.panelCode}>가상 거래 내역 · READ ONLY</span>
          </header>
          <div className={styles.blotterTable} role="table" aria-label="Paper Blotter 빈 상태" tabIndex={0}>
            <div role="row" className={styles.blotterHead}>
              {(["시간 (UTC)", "종목", "작업", "수량", "가격", "상태"] as const).map((label) => <span role="columnheader" key={label}>{label}</span>)}
            </div>
            <div role="row" className={styles.blotterEmpty}>
              <span role="cell">로그인 필요 · 로그인 후 가상 거래 내역을 확인할 수 있습니다.</span>
            </div>
          </div>
        </section>
      </main>

      <div className={styles.srStatus} role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    </div>
  );
}

import type { ReactNode } from "react";

import type { GuestPanelState } from "./contracts";
import { presentGuestPanel } from "./guest-panel-presenter";
import styles from "./guest-terminal-shell.module.css";

export function GuestPanel({
  title,
  state,
  className,
  children,
}: Readonly<{
  title: string;
  state: GuestPanelState;
  // `| undefined` 는 의도적이다 — CSS 모듈 조회(`styles.x`)가 `string | undefined` 라
  // 호출부가 `className={styles.x}` 로 넘긴다. 여기서 존재/부재는 의미 차이가 없다.
  className?: string | undefined;
  children?: ReactNode;
}>) {
  const view = presentGuestPanel(state);
  const classes = [styles.panel, className].filter(Boolean).join(" ");
  return (
    <section className={classes} data-panel-key={state.panelKey} aria-labelledby={`${state.panelKey}-title`}>
      {/* 내부 패널 키는 헤더에서 뺀다 — 사용자에게 의미 없는 식별자다(ticket 35).
          data-panel-key 속성은 남는다: 스타일·테스트가 쓰는 계약이고 화면에는 안 보인다. */}
      <header className={styles.panelHeader}>
        <h2 id={`${state.panelKey}-title`}>{title}</h2>
      </header>
      <div
        className={styles.panelScroll}
        data-scroll-region="panel"
        tabIndex={0}
        aria-label={`${title} 스크롤 영역`}
      >
        <div
          className={`${styles.outcome} ${styles[`tone_${view.tone}`]}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-state={state.state === "pending" ? state.phase : state.outcome.status}
        >
          <div className={styles.outcomeHeading}>
            <span className={styles.stateMark} aria-hidden="true" />
            <strong>{view.statusLabel}</strong>
          </div>
          {view.primaryValue ? (
            <div className={styles.valueBlock}>
              <span>{view.valueLabel}</span>
              <output data-role="primary-value">{view.primaryValue}</output>
            </div>
          ) : null}
          {view.summary ? <p className={styles.summaryLine}>{view.summary}</p> : <p>{view.statusDetail}</p>}
        </div>
        {/* 출처·정책 추적은 계약대로 남기되 평소 화면에서는 접는다(ticket 35). 네이티브 details라
            키보드·스크린리더 동작을 직접 구현하지 않는다. */}
        {view.provenance.length > 0 ? (
          <details className={styles.provenanceDetails}>
            <summary>{view.summary ? "상세" : "상세 · 왜 값이 없는지"}</summary>
            <dl className={styles.provenance} aria-label={`${title} provenance`}>
              {view.provenance.map((entry) => (
                <div key={entry.label}>
                  <dt>{entry.label}</dt>
                  <dd>{entry.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export function LoginGate({ title, feature }: Readonly<{ title: string; feature: string }>) {
  return (
    <section className={`${styles.panel} ${styles.loginPanel}`} aria-labelledby={`${feature}-title`} data-access="login_required">
      <header className={styles.panelHeader}>
        <h2 id={`${feature}-title`}>{title}</h2>
        <span className={styles.panelCode}>GUEST</span>
      </header>
      <div
        className={`${styles.panelScroll} ${styles.loginGate}`}
        data-scroll-region="panel"
        tabIndex={0}
        aria-label={`${title} 스크롤 영역`}
      >
        <span className={styles.lockIcon} aria-hidden="true">◎</span>
        <strong>로그인 필요</strong>
        <p>로그인 후 사용할 수 있습니다.</p>
        <a href="/signin" aria-label={`${title} 사용을 위해 로그인`}>로그인</a>
      </div>
    </section>
  );
}

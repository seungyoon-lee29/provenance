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
  className?: string;
  children?: ReactNode;
}>) {
  const view = presentGuestPanel(state);
  const classes = [styles.panel, className].filter(Boolean).join(" ");
  return (
    <section className={classes} data-panel-key={state.panelKey} aria-labelledby={`${state.panelKey}-title`}>
      <header className={styles.panelHeader}>
        <h2 id={`${state.panelKey}-title`}>{title}</h2>
        <span className={styles.panelCode}>{state.panelKey}</span>
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
          <p>{view.statusDetail}</p>
        </div>
        {view.provenance.length > 0 ? (
          <dl className={styles.provenance} aria-label={`${title} provenance`}>
            {view.provenance.map((entry) => (
              <div key={entry.label}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
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
        <button type="button" aria-label={`${title} 로그인을 준비 중입니다`} disabled>로그인 준비 중</button>
      </div>
    </section>
  );
}

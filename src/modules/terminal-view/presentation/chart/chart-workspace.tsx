"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { chartIntervalsForRange } from "../../../financial-information/chart/chart-manifest";
import { chartRanges } from "../../../financial-information/chart/contracts";
import type { ChartInterval, ChartRange, ChartSelection } from "../../../financial-information/chart/contracts";

import { presentChartFrame } from "./chart-presenter";
import type { GuestChartMode } from "./chart-server";
import { chartSystemClock, createChartTracer } from "./chart-tracer";
import type { ChartFrame } from "./chart-tracer";
import styles from "./chart-workspace.module.css";

type Tracer = ReturnType<typeof createChartTracer>;

const chartSymbols = ["AAPL", "MSFT", "005930.KS", "SLOW"] as const;

export function ChartWorkspace({ initialFrame, mode }: Readonly<{
  initialFrame: ChartFrame;
  mode: GuestChartMode;
}>) {
  const [frame, setFrame] = useState<ChartFrame>(initialFrame);
  const [selection, setSelection] = useState<ChartSelection>(initialFrame.selection);
  const [pending, setPending] = useState(false);
  const tracerRef = useRef<Tracer | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (mode !== "synthetic") return;
    let active = true;
    void import("../../../financial-information/chart/scripted-chart-information").then((module) => {
      if (!active) return;
      tracerRef.current = createChartTracer({
        chartInformation: module.createScriptedChartInformation(chartSystemClock),
        viewer: { kind: "guest", requestId: "guest-chart" },
      });
      setReady(true);
    });
    return () => { active = false; };
  }, [mode]);

  const interactive = mode === "synthetic" && ready;
  const view = useMemo(() => presentChartFrame(frame), [frame]);

  async function choose(next: ChartSelection) {
    setSelection(next);
    const tracer = tracerRef.current;
    if (!tracer) return;
    setPending(true);
    const result = await tracer.select(next);
    if (!result) return; // superseded by a newer selection: never paints
    setFrame(result);
    setPending(false);
  }

  function chooseRange(range: ChartRange) {
    const intervals = chartIntervalsForRange(range);
    const interval = intervals.includes(selection.interval) ? selection.interval : intervals[0]!;
    void choose({ ...selection, range, interval });
  }

  return (
    <div
      className={styles.workspace}
      data-chart-workspace={mode}
      aria-busy={pending}
      aria-label="공개 차트 tracer"
    >
      <div className={styles.controls}>
        <div className={styles.controlGroup} role="group" aria-label="종목 선택">
          <span>종목</span>
          {chartSymbols.map((symbol) => (
            <button
              key={symbol}
              type="button"
              aria-pressed={selection.symbol === symbol}
              disabled={!interactive}
              onClick={() => void choose({ ...selection, symbol })}
            >
              {symbol}
            </button>
          ))}
        </div>
        <div className={styles.controlGroup} role="group" aria-label="기간 선택">
          <span>기간</span>
          {chartRanges.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={selection.range === range}
              disabled={!interactive}
              onClick={() => chooseRange(range)}
            >
              {range}
            </button>
          ))}
        </div>
        <div className={styles.controlGroup} role="group" aria-label="interval 선택">
          <span>Interval</span>
          {chartIntervalsForRange(selection.range).map((interval: ChartInterval) => (
            <button
              key={interval}
              type="button"
              aria-pressed={selection.interval === interval}
              disabled={!interactive}
              onClick={() => void choose({ ...selection, interval })}
            >
              {interval}
            </button>
          ))}
        </div>
      </div>

      <p
        className={styles.summary}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-role="chart-summary"
        data-chart-symbol={frame.selection.symbol}
        data-chart-range={frame.selection.range}
        data-chart-interval={frame.selection.interval}
        data-chart-count={view.hasValue ? String(view.metrics.find((metric) => metric.label === "봉 수")?.value ?? "") : "0"}
        data-chart-tone={view.tone}
      >
        {view.accessibleSummary}
      </p>

      {view.hasValue ? (
        <dl className={styles.metrics} aria-label="차트 지표">
          {view.metrics.map((metric) => (
            <div key={metric.label}>
              <dt>{metric.label}</dt>
              <dd data-role={metric.label === "마지막 종가" ? "chart-value" : undefined}>{metric.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className={styles.notice}>{view.statusDetail}</p>
      )}

      {/* 패널과 같은 규칙(ticket 35): 출처·정책은 계약대로 남기되 평소 화면에서는 접는다. */}
      <details className={styles.provenanceDetails}>
        <summary>{view.hasValue ? "상세" : "상세 · 왜 값이 없는지"}</summary>
        <dl className={styles.metrics} aria-label="차트 provenance">
          {view.provenance.map((entry) => (
            <div key={entry.label}>
              <dt>{entry.label}</dt>
              <dd>{entry.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

import type { ChartFrame } from "./chart-tracer";
import type { ChartSeriesValue } from "../../../financial-information/chart/contracts";

export type ChartMetric = Readonly<{ label: string; value: string }>;

export type ChartPresentation = Readonly<{
  statusLabel: string;
  statusDetail: string;
  tone: "available" | "notice" | "failed";
  hasValue: boolean;
  accessibleSummary: string;
  metrics: readonly ChartMetric[];
  provenance: readonly ChartMetric[];
}>;

const freshnessLabels = { realtime: "실시간", delayed: "지연", stale: "오래됨" } as const;

function lastDefined(series: readonly (number | null)[]): number | null {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const value = series[index];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

const format = (value: number | null): string => (value === null ? "—" : value.toFixed(2));

function availableChart(value: ChartSeriesValue, freshness: "realtime" | "delayed" | "stale"): Readonly<{
  accessibleSummary: string;
  metrics: readonly ChartMetric[];
}> {
  const { summary, indicators } = value;
  const first = summary.first?.close ?? null;
  const last = summary.last?.close ?? null;
  const accessibleSummary =
    `${value.symbol} ${value.range}·${value.interval} 차트, ${summary.count}개 봉, ` +
    `첫 종가 ${format(first)}, 마지막 종가 ${format(last)}, 고가 ${format(summary.high)}, 저가 ${format(summary.low)}, ` +
    `${freshnessLabels[freshness]}`;
  const metrics: ChartMetric[] = [
    { label: "봉 수", value: String(summary.count) },
    { label: "첫 종가", value: format(first) },
    { label: "마지막 종가", value: format(last) },
    { label: "고가", value: format(summary.high) },
    { label: "저가", value: format(summary.low) },
    { label: "이동평균", value: format(lastDefined(indicators.movingAverage)) },
    { label: "RSI", value: format(lastDefined(indicators.rsi)) },
    { label: "MACD", value: format(lastDefined(indicators.macd.macd)) },
  ];
  return { accessibleSummary, metrics };
}

export function presentChartFrame(frame: ChartFrame): ChartPresentation {
  const { outcome, selection } = frame;
  if (outcome.status === "available") {
    const { accessibleSummary, metrics } = availableChart(outcome.value, outcome.freshness);
    return {
      statusLabel: freshnessLabels[outcome.freshness],
      statusDetail: outcome.degradation
        ? "마지막 확인된 봉입니다. 공급자 갱신이 지연되어 재시도 중입니다."
        : "공개 표시 범위가 확인된 차트입니다.",
      tone: "available",
      hasValue: true,
      accessibleSummary,
      metrics,
      provenance: [
        { label: "Evidence Reference", value: outcome.evidenceReference },
        { label: "Provider", value: outcome.provider },
        { label: "Feed", value: outcome.feed },
        { label: "As of", value: outcome.asOf },
        { label: "Data Freshness", value: freshnessLabels[outcome.freshness] },
        { label: "Price Basis", value: outcome.value.priceBasis },
        { label: "Indicator Policy", value: outcome.value.indicators.policyVersion },
        { label: "License Scope", value: `${outcome.licenseScope.audience} · ${outcome.licenseScope.purposes.join(", ")}` },
        { label: "Policy Version", value: outcome.policyVersion },
      ],
    };
  }

  const noValueSummary = `${selection.symbol} ${selection.range}·${selection.interval} 차트, 표시 가능한 값 없음`;
  if (outcome.status === "failed") {
    const failureCopy = {
      quota: ["공급자 quota 초과", "공급자 quota가 회복되기 전까지 차트를 표시하지 않습니다."],
      timeout: ["공급자 응답 실패", "공급자 응답 시간이 초과됐습니다."],
      upstream: ["공급자 장애", "공급자 서비스가 복구되면 안전하게 다시 확인합니다."],
      reauthentication_required: ["공급자 재인증 필요", "자격 증명을 다시 확인하기 전까지 차트를 표시하지 않습니다."],
      forbidden_upstream: ["공급자 접근 거부", "공급자 권한 거부를 값 없음과 구분해 기록했습니다."],
      invalid_response: ["공급자 응답 오류", "올바르지 않은 응답을 차트 값으로 표시하지 않았습니다."],
    } as const;
    const [failureLabel, failureDetail] = failureCopy[outcome.degradation.code];
    const retryLabel = outcome.degradation.retryable ? "재시도 가능" : "자동 재시도 없음";
    return {
      statusLabel: `${failureLabel} · ${retryLabel}`,
      statusDetail: failureDetail,
      tone: "failed",
      hasValue: false,
      accessibleSummary: noValueSummary,
      metrics: [],
      provenance: [
        { label: "Code", value: outcome.degradation.code },
        { label: "Provider", value: outcome.degradation.provider },
        { label: "Occurred at", value: outcome.degradation.occurredAt },
        { label: "Retry", value: retryLabel },
        { label: "Diagnostic Reference", value: outcome.degradation.diagnosticReference },
        { label: "Policy Version", value: outcome.policyVersion },
      ],
    };
  }

  if (outcome.reason === "api_required") {
    return {
      statusLabel: "API 필요", statusDetail: "차트 표시 capability가 없어 값을 표시하지 않습니다.", tone: "notice",
      hasValue: false, accessibleSummary: noValueSummary, metrics: [],
      provenance: [
        { label: "Required capability", value: outcome.requiredCapability },
        { label: "Configuration route", value: outcome.configurationRoute },
        { label: "Policy Version", value: outcome.policyVersion },
      ],
    };
  }
  if (outcome.reason === "license_restricted") {
    return {
      statusLabel: "표시 권한 없음", statusDetail: "현재 License Scope에서는 이 차트를 공개할 수 없습니다.", tone: "notice",
      hasValue: false, accessibleSummary: noValueSummary, metrics: [],
      provenance: [
        { label: "Source", value: outcome.source },
        { label: "Purpose", value: outcome.purpose },
        { label: "Policy Version", value: outcome.policyVersion },
      ],
    };
  }
  return {
    statusLabel: "데이터 없음", statusDetail: "요청 범위에 확인 가능한 봉이 없습니다.", tone: "notice",
    hasValue: false, accessibleSummary: noValueSummary, metrics: [],
    provenance: [
      { label: "Range", value: outcome.queryRange },
      { label: "As of", value: outcome.asOf },
      { label: "Policy Version", value: outcome.policyVersion },
    ],
  };
}

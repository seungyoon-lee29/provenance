import type { GuestPanelPending, GuestPanelReady } from "./contracts";

type GuestPanelPresentationInput =
  | Omit<GuestPanelPending, "panelKey">
  | Omit<GuestPanelReady, "panelKey">;

export type GuestPanelPresentation = Readonly<{
  statusLabel: string;
  statusDetail: string;
  tone: "available" | "pending" | "notice" | "failed";
  primaryValue?: string;
  valueLabel?: string;
  /** 평소 화면에 남는 한 줄 — 출처 · 신선도 · 시각. 값이 있는 outcome에서만 만든다(ticket 35). */
  summary?: string;
  provenance: readonly Readonly<{ label: string; value: string }>[];
}>;

const freshnessLabels = {
  realtime: "실시간",
  delayed: "지연",
  stale: "오래됨",
} as const;

/**
 * 일별 공표(재무부·ECB)는 asOf가 자정 UTC라 시각을 붙이면 노이즈뿐이다 — 날짜만 보여준다.
 * 장중 관측은 시각이 정보이므로 분까지 남기되, UTC임을 표기한다(KST로 읽히면 9시간 거짓말이 된다).
 */
function asOfLabel(asOf: string): string {
  const [date, time] = asOf.split("T");
  if (date === undefined) return asOf;
  if (time === undefined || time.startsWith("00:00")) return date;
  return `${date} ${time.slice(0, 5)} UTC`;
}

export function presentGuestPanel(state: GuestPanelPresentationInput): GuestPanelPresentation {
  if (state.state === "pending") {
    return {
      statusLabel: state.phase === "provider_wait" ? "공급자 응답 대기" : "데이터 확인 중",
      statusDetail: state.phase === "provider_wait"
        ? "공개 공급자의 응답을 기다리고 있습니다. 10초 안에 정확한 결과로 종료됩니다."
        : "로컬 공개 캐시를 확인하고 있습니다.",
      tone: "pending",
      provenance: [],
    };
  }

  const { outcome } = state;
  if (outcome.status === "available") {
    const degradation = outcome.degradation ? [
      { label: "Degradation code", value: outcome.degradation.code },
      { label: "Retry", value: outcome.degradation.retryable ? "가능" : "자동 재시도 없음" },
    ] : [];
    return {
      statusLabel: freshnessLabels[outcome.freshness],
      statusDetail: outcome.degradation
        ? "마지막 관측값입니다. 공급자 갱신이 지연되어 재시도 중입니다."
        : "공개 표시 범위가 확인된 관측값입니다.",
      tone: "available",
      primaryValue: outcome.value.displayValue,
      valueLabel: outcome.value.label,
      // 갱신 지연은 드물지만 사용자에게 의미 있는 사실이라 한 줄 요약에 남긴다(상세 코드는 토글에).
      summary: `${outcome.provider} · ${freshnessLabels[outcome.freshness]} · ${asOfLabel(outcome.asOf)}${outcome.degradation ? " · 갱신 지연" : ""}`,
      provenance: [
        { label: "Evidence Reference", value: outcome.evidenceReference },
        { label: "Provider", value: outcome.provider },
        { label: "Feed", value: outcome.feed },
        { label: "Venue", value: outcome.venue ?? "미지정" },
        { label: "As of", value: outcome.asOf },
        { label: "Received at", value: outcome.receivedAt },
        { label: "Data Freshness", value: freshnessLabels[outcome.freshness] },
        { label: "License Scope", value: `${outcome.licenseScope.audience} · ${outcome.licenseScope.purposes.join(", ")}` },
        { label: "Policy Version", value: outcome.policyVersion },
        ...degradation,
      ],
    };
  }

  if (outcome.status === "failed") {
    const failureCopy = {
      quota: ["공급자 quota 초과", "공급자 quota가 회복되기 전까지 값을 표시하지 않습니다."],
      timeout: ["공급자 응답 실패", "공급자 응답 시간이 초과됐습니다."],
      upstream: ["공급자 장애", "공급자 서비스가 복구되면 안전하게 다시 확인합니다."],
      reauthentication_required: ["공급자 재인증 필요", "자격 증명을 다시 확인하기 전까지 값을 표시하지 않습니다."],
      forbidden_upstream: ["공급자 접근 거부", "공급자 권한 거부를 값 없음과 구분해 기록했습니다."],
      invalid_response: ["공급자 응답 오류", "올바르지 않은 응답을 값으로 표시하지 않았습니다."],
    } as const;
    const [failureLabel, failureDetail] = failureCopy[outcome.degradation.code];
    const retryLabel = outcome.degradation.retryable ? "재시도 가능" : "자동 재시도 없음";
    return {
      statusLabel: `${failureLabel} · ${retryLabel}`,
      statusDetail: failureDetail,
      tone: "failed",
      provenance: [
        { label: "Code", value: outcome.degradation.code },
        { label: "Provider", value: outcome.degradation.provider },
        { label: "Feed", value: outcome.degradation.feed ?? "미지정" },
        { label: "Occurred at", value: outcome.degradation.occurredAt },
        { label: "Retry", value: retryLabel },
        ...(outcome.degradation.retryAfter ? [{ label: "Retry after", value: outcome.degradation.retryAfter }] : []),
        { label: "Diagnostic Reference", value: outcome.degradation.diagnosticReference },
        { label: "Policy Version", value: outcome.policyVersion },
      ],
    };
  }

  if (outcome.reason === "api_required") {
    return {
      statusLabel: "API 필요",
      statusDetail: "공개 표시 capability가 없어 값을 표시하지 않습니다.",
      tone: "notice",
      provenance: [
        { label: "Required capability", value: outcome.requiredCapability },
        { label: "Configuration route", value: outcome.configurationRoute },
        { label: "Policy Version", value: outcome.policyVersion },
      ],
    };
  }
  if (outcome.reason === "license_restricted") {
    return {
      statusLabel: "표시 권한 없음",
      statusDetail: "현재 License Scope에서는 이 정보를 공개할 수 없습니다.",
      tone: "notice",
      provenance: [
        { label: "Source", value: outcome.source },
        { label: "Purpose", value: outcome.purpose },
        { label: "Policy Version", value: outcome.policyVersion },
      ],
    };
  }
  return {
    statusLabel: "데이터 없음",
    statusDetail: "요청 범위에 확인 가능한 관측값이 없습니다.",
    tone: "notice",
    provenance: [
      { label: "Range", value: outcome.queryRange },
      { label: "As of", value: outcome.asOf },
      { label: "Policy Version", value: outcome.policyVersion },
    ],
  };
}

import type { InformationOutcome } from "@/shared";
import type { MarketInformation, MarketObservation } from "@/modules/financial-information/data/contracts";
import type { WorkspaceViewerContext } from "@/shared/contracts/viewer-context";

import type {
  GuestFinancialInformation,
  GuestFinancialLoad,
  GuestFinancialQuery,
  GuestFinancialUpdates,
  GuestPanelValue,
} from "./contracts";

/**
 * 로그인한 소유자용 패널 소스 (ticket 36). 게스트 소스와 **같은 포트**라 셸은 바뀌지 않고 데이터만
 * 바뀐다. KIS가 답할 수 있는 패널만 개인 경로로 보내고 나머지는 공개 소스로 넘긴다.
 *
 * 뷰어는 인자가 아니라 **조립 시점의 세션에서 확정**된다: 이 소스는 게스트 요청 경로에서 만들어지지
 * 않고, 만들어진 뒤에도 넘어온 게스트 뷰어로 개인 read를 하지 않는다(map line 16 재배포 금지).
 * 어댑터의 scope guard가 owner·personal_display가 아니면 네트워크 0으로 값 없는 outcome을 준다.
 */
const PERSONAL_PANEL_SYMBOLS: Readonly<Partial<Record<GuestFinancialQuery["panelKey"], { symbol: string; label: string }>>> = {
  "index-kospi": { symbol: "KOSPI", label: "코스피" },
  "market-overview": { symbol: "KOSDAQ", label: "코스닥" },
  // ponytail: 관심종목 v1은 대표 종목 한 건이다. 사용자별 관심목록 저장·목록 UI는 후속 티켓.
  watchlist: { symbol: "005930", label: "삼성전자" },
};

const decimalFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

/** 값이 있을 때만 표시 문자열을 만든다 — 값 없는 outcome은 그대로 통과한다. */
function toPanelOutcome(
  outcome: InformationOutcome<MarketObservation>,
  label: string,
): InformationOutcome<GuestPanelValue> {
  if (outcome.status !== "available") return outcome;
  const sign = outcome.value.change >= 0 ? "+" : "";
  const value: GuestPanelValue = {
    label,
    displayValue: decimalFormat.format(outcome.value.last),
    unit: `${sign}${outcome.value.changePercent}%`,
  };
  return { ...outcome, value };
}

export function createPersonalFinancialInformation(deps: Readonly<{
  market: MarketInformation;
  viewer: WorkspaceViewerContext;
  fallback: GuestFinancialInformation;
}>): GuestFinancialInformation {
  return {
    read(query: GuestFinancialQuery, guestViewer): GuestFinancialLoad {
      const wired = PERSONAL_PANEL_SYMBOLS[query.panelKey];
      if (!wired) return deps.fallback.read(query, guestViewer);
      const load = deps.market.read(
        {
          kind: "FinancialQuery",
          symbol: wired.symbol,
          purpose: "personal_display",
          requestRevision: query.requestRevision,
        },
        deps.viewer,
      );
      return {
        kind: "FinancialLoad",
        cache: load.cache,
        query,
        result: load.result.then((outcome) => toPanelOutcome(outcome, wired.label)),
      };
    },
    follow(): GuestFinancialUpdates {
      return { async *[Symbol.asyncIterator]() { return; } };
    },
  };
}

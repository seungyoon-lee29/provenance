import { brandReference } from "../../../shared/contracts/brands";
import type { AvailableInformation } from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";

import type { EvidenceOutcome, EvidenceValue, FilingEntry } from "./evidence-contracts";
import type { ProviderFailureKind } from "./contracts";
import { OBSERVATION_POLICY_VERSION } from "./outcome-classification";
import { apiRequiredOutcome, classifyProviderFailure, noDataOutcome } from "./outcome-classification";
import { DATA_DEADLINE_MS, withDeadline, type Sleep } from "./deadline";

/**
 * Open DART 최근 공시 목록 어댑터 (ticket 33-a) — third public guest-track source. Filing METADATA
 * (company, form, receipt number/date) is public information served with attribution; the API key
 * is server-side access control only and must never surface in any outcome or reference. Reuses
 * the F4 `FilingEntry`/`EvidenceValue` contract — filings are evidence, not market observations.
 */

export type DartHttpRequest = Readonly<{ url: string }>;
export type DartHttpResponse = Readonly<{ status: number; json: unknown }>;
export type DartHttp = (request: DartHttpRequest) => Promise<DartHttpResponse>;

export type DartClock = Readonly<{ now(): number; sleep: Sleep }>;

export type DartConfig = Readonly<{
  base: string;
  /** Server-side access key — flows ONLY into the request URL, never into outcomes. */
  apiKey: string;
  /** validUntil for the public LicenseScope attached to every outcome. */
  licenseValidUntil: string;
}>;

/** Minimal filings port (v1): one recent-list read. Widens when the guest panel grows a real list UI. */
export interface FilingsInformation {
  readRecent(viewer: ViewerContext): Promise<EvidenceOutcome>;
}

const PROVIDER = "dart";
const FEED = "dart:latest-list";
const PAGE_COUNT = 10;

type DartDeps = Readonly<{ http: DartHttp; clock: DartClock; config: DartConfig }>;

function statusFailure(status: number, nowMs: number): ProviderFailureKind {
  if (status === 429) return { kind: "quota", retryAfter: new Date(nowMs + 60_000).toISOString() };
  if (status >= 500) return { kind: "upstream" };
  return { kind: "invalid_response" };
}

/**
 * DART business status → typed failure ("000" ok and "013" no-data are handled by the caller).
 * Exhaustive over the official guide: key states (010/011/901) need re-registration, access
 * denials (012/101) are terminal, request-shape errors (100) must not retry, quota (020/021)
 * retries later, maintenance (800) retries.
 */
function dartStatusFailure(code: string, nowMs: number): ProviderFailureKind {
  if (code === "010" || code === "011" || code === "901") return { kind: "reauthentication_required" };
  if (code === "012" || code === "101") return { kind: "denied", denial: "other" };
  if (code === "100") return { kind: "invalid_response" };
  if (code === "020" || code === "021") return { kind: "quota", retryAfter: new Date(nowMs + 60_000).toISOString() };
  return { kind: "upstream" }; // 800 시스템 점검, 900 미정의 등
}

/** rcept_dt arrives as YYYYMMDD; anything else fails closed instead of becoming a fake date. */
function toFiledAt(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !/^\d{8}$/.test(raw)) return undefined;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const ms = Date.parse(`${iso}T00:00:00.000Z`);
  if (!new Date(ms).toISOString().startsWith(iso)) return undefined;
  return new Date(ms).toISOString();
}

/** Egress gate: with the public track off or no key configured, every read answers locally. */
export function createDisabledFilingsInformation(): FilingsInformation {
  return {
    readRecent: async () => apiRequiredOutcome("dart_public_filings", "/settings/providers"),
  };
}

export function createDartFilingsInformation(deps: DartDeps): FilingsInformation {
  const { http, config, clock } = deps;

  async function settle(): Promise<EvidenceOutcome> {
    let occurredAt = new Date().toISOString();
    try {
      const nowMs = clock.now();
      occurredAt = new Date(nowMs).toISOString();

      const res = await http({
        url: `${config.base}/api/list.json?crtfc_key=${encodeURIComponent(config.apiKey)}&page_count=${PAGE_COUNT}`,
      });
      if (res.status < 200 || res.status >= 300) {
        return classifyProviderFailure({ failure: statusFailure(res.status, nowMs), provider: PROVIDER, feed: FEED, occurredAt });
      }
      const body = (res.json ?? {}) as { status?: unknown; list?: unknown };
      // Reflected-secret quarantine: no upstream string is trusted to be key-free. If the body
      // echoes the access key anywhere, the whole response is refused before any field can carry
      // it into an outcome, link, or evidence reference.
      if (JSON.stringify(body).includes(config.apiKey)) {
        return classifyProviderFailure({ failure: { kind: "invalid_response" }, provider: PROVIDER, feed: FEED, occurredAt });
      }
      if (typeof body.status !== "string") {
        return classifyProviderFailure({ failure: { kind: "invalid_response" }, provider: PROVIDER, feed: FEED, occurredAt });
      }
      if (body.status === "013") return noDataOutcome("dart:latest", occurredAt);
      if (body.status !== "000") {
        return classifyProviderFailure({ failure: dartStatusFailure(body.status, nowMs), provider: PROVIDER, feed: FEED, occurredAt });
      }
      if (!Array.isArray(body.list)) {
        return classifyProviderFailure({ failure: { kind: "invalid_response" }, provider: PROVIDER, feed: FEED, occurredAt });
      }

      const filings: FilingEntry[] = [];
      for (const item of body.list as readonly Record<string, unknown>[]) {
        const filedAt = toFiledAt(item.rcept_dt);
        // 접수번호는 공식 14자리 숫자 — 그 밖의 문자열은 link/reference로 절대 승격되지 않는다.
        const accession = typeof item.rcept_no === "string" && /^\d{14}$/.test(item.rcept_no) ? item.rcept_no : undefined;
        const form = typeof item.report_nm === "string" ? item.report_nm : undefined;
        const source = typeof item.corp_name === "string" ? item.corp_name : undefined;
        // One malformed entry poisons the list: refusing beats silently dropping rows (a partial
        // list would misrepresent "the latest filings").
        if (!filedAt || !accession || !form || !source) {
          return classifyProviderFailure({ failure: { kind: "invalid_response" }, provider: PROVIDER, feed: FEED, occurredAt });
        }
        filings.push({
          form,
          source,
          filedAt,
          accession,
          link: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(accession)}`,
          evidenceReference: brandReference<string, "EvidenceReference">(`evidence:f4:filing:${accession}:${FEED}`),
        });
      }
      if (filings.length === 0) return noDataOutcome("dart:latest", occurredAt);

      const value: EvidenceValue = { kind: "filing", filings };
      // The list is a live query answered at read time: asOf = receipt time, realtime by
      // construction. Spec §5.1 "DART latest list" soft 5분 is enforced by the composition's
      // transport TTL cache, not by aging a stored value.
      const available: AvailableInformation<EvidenceValue> = {
        status: "available",
        value,
        evidenceReference: brandReference<string, "EvidenceReference">(`evidence:f4:filing-list:${FEED}`),
        provider: PROVIDER,
        feed: FEED,
        asOf: occurredAt,
        receivedAt: occurredAt,
        freshness: "realtime",
        licenseScope: { audience: "public", purposes: ["public_display"], validUntil: config.licenseValidUntil },
        policyVersion: OBSERVATION_POLICY_VERSION,
      };
      return available;
    } catch {
      return classifyProviderFailure({ failure: { kind: "timeout" }, provider: PROVIDER, feed: FEED, occurredAt });
    }
  }

  return {
    readRecent(viewer: ViewerContext): Promise<EvidenceOutcome> {
      void viewer; // public metadata with attribution: every viewer may read
      return withDeadline(settle(), {
        deadlineMs: DATA_DEADLINE_MS,
        sleep: clock.sleep,
        onTimeout: () =>
          classifyProviderFailure({
            failure: { kind: "timeout" },
            provider: PROVIDER,
            feed: FEED,
            occurredAt: new Date().toISOString(),
          }),
      });
    },
  };
}

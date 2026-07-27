import type { EvidenceReference, InformationOutcome } from "@/shared";
import type { ViewerContext } from "@/shared/contracts/viewer-context";

/**
 * News/filing Evidence (§5.3). News carries only title/source/time/link and a
 * rights-permitted snippet — never full article text or images. Filings carry
 * the form/source/accession/link. Both flow through the same freshness/error
 * normalization machine as market observations.
 */

export type NewsHeadline = Readonly<{
  title: string;
  source: string;
  publishedAt: string;
  link: string;
  // `| undefined` 는 의도적이다 — 이 값은 JSON 픽스처/제공자 응답을 zod 로 파싱해 오므로
  // "키 없음"과 "키가 undefined" 가 실제로 둘 다 발생하고 의미 차이가 없다.
  snippet?: string | undefined;
  evidenceReference: EvidenceReference;
}>;

export type FilingEntry = Readonly<{
  form: string;
  source: string;
  filedAt: string;
  accession: string;
  link: string;
  evidenceReference: EvidenceReference;
}>;

export type EvidenceKind = "news" | "filing";

export type EvidenceValue =
  | Readonly<{ kind: "news"; headlines: readonly NewsHeadline[] }>
  | Readonly<{ kind: "filing"; filings: readonly FilingEntry[] }>;

export type EvidenceOutcome = InformationOutcome<EvidenceValue>;

/**
 * Server-only collaboration seam (§6.1): ResearchAssistant resolves an opaque
 * source reference to purpose-bound typed material — never a raw Evidence
 * getter. Returns a value-less outcome when rights/purpose/freshness deny it.
 */
export interface EvidenceResolver {
  resolve(reference: EvidenceReference, purpose: string, viewer: ViewerContext): Promise<EvidenceOutcome>;
}

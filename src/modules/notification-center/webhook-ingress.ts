import { TokenBucket } from "./email-throttle";

/**
 * F5 Resend webhook ingress limits (spec §12 line 343), enforced BEFORE the raw
 * body is buffered: POST + JSON only, at most 64 headers / 16 KiB of headers,
 * a 256 KiB raw body and a 2 second deadline, with a 10 rps / burst 50 lane per
 * peer and a 50 rps / burst 100 global lane.
 */
export const WEBHOOK_INGRESS = {
  maxHeaders: 64,
  maxHeaderBytes: 16 * 1024,
  maxBodyBytes: 256 * 1024,
  deadlineMs: 2_000,
  peerRatePerSecond: 10,
  peerBurst: 50,
  globalRatePerSecond: 50,
  globalBurst: 100,
} as const;

export type WebhookIngressRequest = Readonly<{
  method: string;
  contentType: string | undefined;
  headerCount: number;
  headerBytes: number;
  /** Declared (Content-Length) size — checked before buffering, re-checked while streaming. */
  declaredBodyBytes: number;
}>;

export type WebhookIngressRejection =
  | "method_not_allowed"
  | "unsupported_media_type"
  | "too_many_headers"
  | "headers_too_large"
  | "body_too_large";

export type WebhookIngressOutcome =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: WebhookIngressRejection }>;

export function checkWebhookIngress(request: WebhookIngressRequest): WebhookIngressOutcome {
  if (request.method !== "POST") return { allowed: false, reason: "method_not_allowed" };
  if (request.contentType === undefined || !request.contentType.toLowerCase().startsWith("application/json")) {
    return { allowed: false, reason: "unsupported_media_type" };
  }
  if (request.headerCount > WEBHOOK_INGRESS.maxHeaders) return { allowed: false, reason: "too_many_headers" };
  if (request.headerBytes > WEBHOOK_INGRESS.maxHeaderBytes) return { allowed: false, reason: "headers_too_large" };
  if (request.declaredBodyBytes > WEBHOOK_INGRESS.maxBodyBytes) return { allowed: false, reason: "body_too_large" };
  return { allowed: true };
}

export function webhookDeadlineExceeded(startedAtMs: number, now: number): boolean {
  return now - startedAtMs >= WEBHOOK_INGRESS.deadlineMs;
}

export type WebhookAdmission = "admitted" | "peer_limited" | "global_limited";

export class WebhookRateLimiter {
  readonly #global = new TokenBucket(WEBHOOK_INGRESS.globalBurst, WEBHOOK_INGRESS.globalRatePerSecond);
  readonly #peers = new Map<string, TokenBucket>();

  admit(peer: string, now: number): WebhookAdmission {
    let bucket = this.#peers.get(peer);
    if (!bucket) {
      bucket = new TokenBucket(WEBHOOK_INGRESS.peerBurst, WEBHOOK_INGRESS.peerRatePerSecond, now);
      this.#peers.set(peer, bucket);
    }
    // Peer lane first so an exhausted peer cannot drain the global lane.
    if (!bucket.tryTake(now)) return "peer_limited";
    if (!this.#global.tryTake(now)) return "global_limited";
    return "admitted";
  }
}

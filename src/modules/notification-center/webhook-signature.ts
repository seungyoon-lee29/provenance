import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * F5 webhook signature verification (spec §12 line 343): the raw signature and
 * timestamp are verified BEFORE the payload is parsed. This implements the
 * published svix scheme Resend uses — signed content `${id}.${timestamp}.${body}`,
 * HMAC-SHA256 keyed by the base64 secret after the `whsec_` prefix, and a
 * space-separated `v1,<base64>` signature header that may carry several
 * candidates during secret rotation.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type WebhookSignatureInput = Readonly<{
  svixId: string;
  timestampSeconds: number;
  rawBody: string;
  signatureHeader: string;
}>;

export type WebhookSignatureRejection =
  | "missing_material"
  | "stale_timestamp"
  | "future_timestamp"
  | "signature_mismatch";

export type WebhookSignatureOutcome =
  | Readonly<{ verified: true }>
  | Readonly<{ verified: false; reason: WebhookSignatureRejection }>;

function signingKey(secret: string): Buffer {
  return secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret, "utf8");
}

export function verifyWebhookSignature(input: WebhookSignatureInput, secret: string, nowMs: number): WebhookSignatureOutcome {
  if (input.svixId === "" || input.signatureHeader === "" || !Number.isFinite(input.timestampSeconds) || secret === "") {
    return { verified: false, reason: "missing_material" };
  }
  const ageSeconds = nowMs / 1000 - input.timestampSeconds;
  if (ageSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return { verified: false, reason: "stale_timestamp" };
  if (-ageSeconds > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return { verified: false, reason: "future_timestamp" };

  const expected = createHmac("sha256", signingKey(secret))
    .update(`${input.svixId}.${input.timestampSeconds}.${input.rawBody}`)
    .digest();
  for (const candidate of input.signatureHeader.split(" ")) {
    const [version, signature] = candidate.split(",", 2);
    if (version !== "v1" || signature === undefined) continue;
    const provided = Buffer.from(signature, "base64");
    if (provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected)) return { verified: true };
  }
  return { verified: false, reason: "signature_mismatch" };
}

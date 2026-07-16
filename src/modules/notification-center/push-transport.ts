import { isIP } from "node:net";

import { isPublicNetworkAddress, resolveProviderHostname } from "../../platform/provider-transport";

/**
 * F5 Web Push transport policy (spec §12 lines 334/349). Endpoint resolution
 * reuses the F0 SSRF primitives (public-address block + DNS lookup): a push
 * endpoint must be an exact-host HTTPS:443 URL with a registered hostname that
 * resolves only to public addresses. The dispatch executor then pins those
 * addresses and forbids redirects (redirect: "error"), so the resolved target
 * cannot be re-pointed at an internal host between resolution and connect.
 */
export const MAX_PUSH_PAYLOAD_BYTES = 4096;
export const MAX_PUSH_ENDPOINTS_PER_INSTALL = 5;

export function assertPushPayloadWithinLimit(payload: Uint8Array): void {
  if (payload.byteLength > MAX_PUSH_PAYLOAD_BYTES) throw new Error("push payload exceeds 4096 bytes");
}

export function assertPushEndpointBudget(endpointCount: number): void {
  if (endpointCount > MAX_PUSH_ENDPOINTS_PER_INSTALL) throw new Error("push install exceeds 5 endpoints");
}

export async function resolvePushTarget(
  endpointUrl: string,
  resolveHost: (hostname: string) => Promise<readonly string[]> = resolveProviderHostname,
): Promise<Readonly<{ target: string; addresses: readonly string[] }>> {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw new Error("push endpoint is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("push endpoint must be HTTPS");
  if (url.port !== "") throw new Error("push endpoint must use the default HTTPS port");
  if (url.username || url.password) throw new Error("push endpoint must not carry credentials");
  if (url.hash) throw new Error("push endpoint must not carry a fragment");
  if (isIP(url.hostname) !== 0) throw new Error("push endpoint must use a registered hostname");
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(url.hostname);
  } catch {
    throw new Error("push endpoint resolution failed");
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicNetworkAddress(address))) {
    throw new Error("push endpoint resolved to a forbidden network");
  }
  return { target: url.href, addresses };
}

export type PushResponse =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "accepted_before_timeout" }>
  | Readonly<{ kind: "status"; code: number }>
  | Readonly<{ kind: "network_error" }>;

export type PushOutcome =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "accepted_unconfirmed" }>
  | Readonly<{ kind: "subscription_inactive" }>
  | Readonly<{ kind: "permanent_failure"; reason: "payload" | "config" }>
  | Readonly<{ kind: "circuit_open" }>
  | Readonly<{ kind: "rate_limited" }>
  | Readonly<{ kind: "retry" }>;

export function classifyPushOutcome(response: PushResponse): PushOutcome {
  switch (response.kind) {
    case "accepted":
      return { kind: "accepted" };
    case "accepted_before_timeout":
      return { kind: "accepted_unconfirmed" };
    case "network_error":
      return { kind: "retry" };
    case "status": {
      const code = response.code;
      if (code >= 200 && code < 300) return { kind: "accepted" };
      if (code === 404 || code === 410) return { kind: "subscription_inactive" };
      if (code === 413) return { kind: "permanent_failure", reason: "payload" };
      if (code === 400) return { kind: "permanent_failure", reason: "config" };
      if (code === 401 || code === 403) return { kind: "circuit_open" };
      if (code === 429) return { kind: "rate_limited" };
      if (code >= 500 && code <= 599) return { kind: "retry" };
      // Any other status is unexpected — fail closed with no retry.
      return { kind: "permanent_failure", reason: "config" };
    }
  }
}

/**
 * A notification tag stable per Delivery Cause. Because every retry of the same
 * cause reuses this tag (and the same service-worker notificationId), an
 * accept-before-timeout retry replaces rather than adds an on-screen
 * notification, converging to at most one (spec §12 line 349).
 */
export function pushNotificationTag(causeId: string): string {
  return `delivery-cause:${causeId}`;
}

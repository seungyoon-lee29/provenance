import { inspect } from "node:util";

import { createNetworkHarness } from "../tests/harness/network-policy";

/**
 * What "egress was blocked" is allowed to LOOK like.
 *
 * The previous form of this check swallowed every error except its own sentinel,
 * so the harness printed "passed" whenever the fetch failed for ANY reason — a
 * typo in the fixture URL, a TLS failure, a programming error in this script.
 * Those failures happen on a fully open network too, so they are not evidence of
 * anything. A gate that cannot distinguish "blocked" from "broke" cannot fail.
 *
 * A network-off runtime denies egress in a small, concrete set of ways: DNS
 * refuses to resolve, the route is dropped (nothing answers, we abort), or the
 * connection is refused/unreachable. Only those count.
 */
const BLOCKED_CODES = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"] as const;

export function blockedReason(error: unknown): string | undefined {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  if (name === "AbortError" || name === "TimeoutError") return "aborted — nothing answered before the timeout (route dropped)";
  // fetch wraps the real failure in `cause` (sometimes an AggregateError of
  // several). Reading the rendered chain keeps this boring and shape-agnostic.
  const chain = inspect(error, { depth: 5 });
  return BLOCKED_CODES.find((code) => chain.includes(code));
}

const allowedOrigins = (process.env.NETWORK_HARNESS_ALLOWED_ORIGINS ?? "http://127.0.0.1:3000,http://127.0.0.1:3001").split(",");
const harness = createNetworkHarness(allowedOrigins);

async function requireReady(target: string): Promise<void> {
  const response = await fetch(harness.assertAllowed(target));
  if (!response.ok) throw new Error(`${target} returned ${response.status}`);
}

function requirePolicyDenied(target: string): void {
  try {
    harness.assertAllowed(target);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("network harness denied origin:")) return;
    throw error;
  }
  throw new Error(`network harness allowed denied origin: ${new URL(target).origin}`);
}

async function main(): Promise<void> {
  const appOrigin = allowedOrigins.find((origin) => new URL(origin).hostname === "app") ?? allowedOrigins[0];
  const workerOrigin = allowedOrigins.find((origin) => new URL(origin).hostname === "worker") ?? allowedOrigins[1];
  if (appOrigin === undefined || workerOrigin === undefined) throw new Error("network harness requires app and worker origins");
  await requireReady(`${appOrigin}/api/ready`);
  await requireReady(`${workerOrigin}/ready`);
  requirePolicyDenied("http://127.0.0.1:3000/localhost-fixture");
  requirePolicyDenied("http://localhost:3000/localhost-fixture");
  requirePolicyDenied("https://example.com/external-fixture");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  let blocked: string | undefined;
  try {
    const response = await fetch("https://example.com/external-fixture", { signal: controller.signal });
    throw new Error(`Docker runtime allowed external egress with status ${response.status}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Docker runtime allowed")) throw error;
    blocked = blockedReason(error);
    if (blocked === undefined) {
      // The fetch failed, but not in a way that proves anything about egress.
      throw new Error(`egress probe failed for a reason that does not prove blocking: ${inspect(error, { depth: 5 })}`);
    }
  } finally {
    clearTimeout(timeout);
  }
  process.stdout.write(`network-off harness passed (external egress blocked: ${blocked})\n`);
}

// Entry-point guard (same pattern as performance-report.ts): `blockedReason` is
// exported so its discrimination can be exercised without opening a socket.
if (process.argv[1]?.endsWith("verify-network-off.ts")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "network-off verification failed"}\n`);
    process.exitCode = 1;
  });
}

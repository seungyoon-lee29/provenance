import { createNetworkHarness } from "../tests/harness/network-policy";

const allowedOrigins = (process.env.NETWORK_HARNESS_ALLOWED_ORIGINS ?? "http://127.0.0.1:3000,http://127.0.0.1:3001").split(",");
const harness = createNetworkHarness(allowedOrigins);

async function requireReady(target: string): Promise<void> {
  const response = await fetch(harness.assertAllowed(target));
  if (!response.ok) throw new Error(`${target} returned ${response.status}`);
}

async function main(): Promise<void> {
  const appOrigin = allowedOrigins.find((origin) => new URL(origin).hostname === "app") ?? allowedOrigins[0];
  const workerOrigin = allowedOrigins.find((origin) => new URL(origin).hostname === "worker") ?? allowedOrigins[1];
  if (appOrigin === undefined || workerOrigin === undefined) throw new Error("network harness requires app and worker origins");
  await requireReady(`${appOrigin}/api/ready`);
  await requireReady(`${workerOrigin}/ready`);
  let policyDenied = false;
  try {
    harness.assertAllowed("https://example.com/external-fixture");
  } catch {
    policyDenied = true;
  }
  if (!policyDenied) throw new Error("external fixture was not denied by policy");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch("https://example.com/external-fixture", { signal: controller.signal });
    throw new Error(`Docker runtime allowed external egress with status ${response.status}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Docker runtime allowed")) throw error;
  } finally {
    clearTimeout(timeout);
  }
  process.stdout.write("network-off harness passed\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "network-off verification failed"}\n`);
  process.exitCode = 1;
});

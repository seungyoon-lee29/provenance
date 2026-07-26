import "server-only";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blockedIpv4.addSubnet(network, prefix, "ipv4");

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedIpv6.addSubnet(network, prefix, "ipv6");

function parseIpv4(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  return octets.length === 4 ? octets : undefined;
}

export function isPublicNetworkAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) {
    return !blockedIpv4.check(address, "ipv4");
  }
  if (isIP(address) === 6) {
    const first = Number.parseInt(address.split(":")[0] ?? "", 16);
    return Number.isFinite(first) && first >= 0x2000 && first <= 0x3fff && !blockedIpv6.check(address, "ipv6");
  }
  return false;
}

export async function resolveProviderHostname(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

export async function assertPublicRoute(routeOrigin: string, routePath: string, resolveHost: (hostname: string) => Promise<readonly string[]>): Promise<Readonly<{ target: string; addresses: readonly string[] }>> {
  const origin = new URL(routeOrigin);
  if (origin.origin !== routeOrigin || origin.protocol !== "https:" || origin.port !== "" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("provider route origin is not an exact HTTPS origin");
  }
  if (isIP(origin.hostname) !== 0) throw new Error("provider route origin must use a registered hostname");
  if (!routePath.startsWith("/") || routePath.startsWith("//") || routePath.includes("?") || routePath.includes("#")) {
    throw new Error("provider route path is not canonical");
  }
  const target = new URL(routePath, origin);
  if (target.origin !== origin.origin) throw new Error("provider route escaped its registered origin");
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(origin.hostname);
  } catch {
    throw new Error("provider route resolution failed");
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicNetworkAddress(address))) {
    throw new Error("provider route resolved to a forbidden network");
  }
  return { target: target.href, addresses };
}

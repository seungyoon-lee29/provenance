import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { assertPublicRoute, isPublicNetworkAddress } from "../../src/platform/provider-transport/network-policy";

/**
 * Standing invariant (ticket 21, ADR 0003, SEC-04): the only HTTP client can
 * never reach a private/reserved network, and a route origin must be an exact
 * public HTTPS origin. These properties bind the SSRF/egress guard over
 * generated inputs, so a future code change that weakens it fails here — not
 * only the container-level `verify:network-off` drill.
 */

const privateIpv4 = fc
  .oneof(
    fc.tuple(fc.constant(10), fc.nat(255), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(127), fc.nat(255), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(192), fc.constant(168), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(169), fc.constant(254), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(100), fc.integer({ min: 64, max: 127 }), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(0), fc.nat(255), fc.nat(255), fc.nat(255)),
  )
  .map((octets) => octets.join("."));

describe("egress-off invariant", () => {
  it("never classifies a private/reserved IPv4 as a public network address", () => {
    fc.assert(fc.property(privateIpv4, (ip) => isPublicNetworkAddress(ip) === false));
  });

  it("never classifies loopback/private IPv6 as public", () => {
    fc.assert(
      fc.property(fc.constantFrom("::1", "::", "fc00::1", "fe80::1", "ff02::1"), (ip) => isPublicNetworkAddress(ip) === false),
    );
  });

  it("rejects any non-HTTPS route origin even when it would resolve publicly", async () => {
    const publicResolve = async () => ["8.8.8.8"];
    await fc.assert(
      fc.asyncProperty(fc.domain(), fc.constantFrom("http", "ftp", "ws"), async (host, scheme) => {
        await expect(assertPublicRoute(`${scheme}://${host}`, "/v1/x", publicResolve)).rejects.toThrow();
      }),
    );
  });

  it("rejects an HTTPS origin that resolves to a private address (SSRF via DNS)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.domain(), privateIpv4, async (host, ip) => {
        await expect(assertPublicRoute(`https://${host}`, "/v1/x", async () => [ip])).rejects.toThrow();
      }),
    );
  });

  it("rejects an origin resolving to ANY private address, even mixed with public ones (rebinding)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.domain(), privateIpv4, fc.integer({ min: 0, max: 2 }), async (host, ip, position) => {
        const addresses = ["8.8.8.8", "1.1.1.1", "9.9.9.9"];
        addresses.splice(position, 0, ip); // a single private address among public ones
        await expect(assertPublicRoute(`https://${host}`, "/v1/x", async () => addresses)).rejects.toThrow();
      }),
    );
  });
});

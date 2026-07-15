import { describe, expect, it } from "vitest";

import { createNetworkHarness } from "./harness/network-policy";

describe("network-off harness", () => {
  const localHarness = createNetworkHarness(["http://127.0.0.1:3000", "http://app:3000", "http://worker:3001"]);
  const prHarness = createNetworkHarness(["http://app:3000", "http://worker:3001"]);

  it("allows only explicitly declared origins", () => {
    expect(localHarness.assertAllowed("http://127.0.0.1:3000/api/health").pathname).toBe("/api/health");
    expect(localHarness.assertAllowed("http://app:3000/api/ready").hostname).toBe("app");
    expect(localHarness.assertAllowed("http://worker:3001/ready").hostname).toBe("worker");
  });

  it("denies an external hostname before any network call", () => {
    expect(() => prHarness.assertAllowed("https://example.com/fixture")).toThrow("network harness denied origin");
  });

  it("denies container localhost in the PR policy", () => {
    expect(() => prHarness.assertAllowed("http://127.0.0.1:3000/api/health")).toThrow("network harness denied origin");
    expect(() => prHarness.assertAllowed("http://localhost:3000/api/health")).toThrow("network harness denied origin");
  });
});

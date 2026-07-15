import { describe, expect, it } from "vitest";

import { createNetworkHarness } from "./harness/network-policy";

describe("network-off harness", () => {
  const harness = createNetworkHarness(["http://127.0.0.1:3000", "http://app:3000", "http://worker:3001"]);

  it("allows only localhost and declared Docker service origins", () => {
    expect(harness.assertAllowed("http://127.0.0.1:3000/api/health").pathname).toBe("/api/health");
    expect(harness.assertAllowed("http://app:3000/api/ready").hostname).toBe("app");
    expect(harness.assertAllowed("http://worker:3001/ready").hostname).toBe("worker");
  });

  it("denies an external hostname before any network call", () => {
    expect(() => harness.assertAllowed("https://example.com/fixture")).toThrow("network harness denied origin");
  });
});

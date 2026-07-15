import { describe, expect, it } from "vitest";

import {
  createGuestTerminalFeature,
  resolveGuestFeatureRuntime,
} from "../src/modules/terminal-view/presentation/guest/public-feature";

describe("guest terminal fixture policy", () => {
  it("allows the visibly marked fixture only outside production", () => {
    expect(createGuestTerminalFeature({ environment: "test", mode: "synthetic" }).marker).toBe("SYNTHETIC TEST DATA");
    expect(() => createGuestTerminalFeature({ environment: "production", mode: "synthetic" })).toThrow(
      "synthetic guest terminal fixture is forbidden in production",
    );
  });

  it("keeps release runtime public unless the explicit test composition is selected", () => {
    expect(resolveGuestFeatureRuntime("production", "20", "production")).toEqual({
      environment: "production",
      mode: "public",
    });
    expect(resolveGuestFeatureRuntime("production", "20", "test")).toEqual({
      environment: "test",
      mode: "synthetic",
      scriptedHitDelayMs: 20,
    });
  });
});

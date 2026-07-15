import { describe, expect, it } from "vitest";

import { synthesizeChannelAvailability } from "../src/modules/notification-center/channel-availability";
import type { ChannelAvailabilityAxes } from "../src/modules/notification-center/channel-availability";

const READY: ChannelAvailabilityAxes = {
  supported: true,
  deploymentReady: true,
  consentAndAddressReady: true,
  permissionGranted: true,
  quotaAvailable: true,
};

describe("synthesizeChannelAvailability (spec §11 line 333)", () => {
  it("is ready when every axis is satisfied", () => {
    expect(synthesizeChannelAvailability(READY)).toBe("ready");
  });

  it("is unsupported when the platform cannot support the channel at all", () => {
    expect(synthesizeChannelAvailability({ ...READY, supported: false })).toBe("unsupported");
  });

  it("is configuration_required when deployment or workspace consent/address is missing", () => {
    expect(synthesizeChannelAvailability({ ...READY, deploymentReady: false })).toBe("configuration_required");
    expect(synthesizeChannelAvailability({ ...READY, consentAndAddressReady: false })).toBe("configuration_required");
  });

  it("is permission_denied when device permission/subscription is not granted", () => {
    expect(synthesizeChannelAvailability({ ...READY, permissionGranted: false })).toBe("permission_denied");
  });

  it("is quota_blocked when category quota or the circuit blocks delivery", () => {
    expect(synthesizeChannelAvailability({ ...READY, quotaAvailable: false })).toBe("quota_blocked");
  });

  it("prefers the more fundamental blocker: unsupported > configuration_required > permission_denied > quota_blocked", () => {
    // everything is wrong at once
    const allBad: ChannelAvailabilityAxes = {
      supported: false,
      deploymentReady: false,
      consentAndAddressReady: false,
      permissionGranted: false,
      quotaAvailable: false,
    };
    expect(synthesizeChannelAvailability(allBad)).toBe("unsupported");
    expect(synthesizeChannelAvailability({ ...allBad, supported: true })).toBe("configuration_required");
    expect(synthesizeChannelAvailability({ ...allBad, supported: true, deploymentReady: true, consentAndAddressReady: true })).toBe("permission_denied");
    expect(synthesizeChannelAvailability({ ...READY, permissionGranted: false, quotaAvailable: false })).toBe("permission_denied");
  });
});

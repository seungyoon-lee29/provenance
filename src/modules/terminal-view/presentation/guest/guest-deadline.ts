import { brandReference } from "../../../../shared/contracts/brands";
import type { InformationOutcome } from "@/shared";

import type { GuestPanelValue, PublicPanelKey } from "./contracts";

export const GUEST_WAITING_AFTER_MS = 2_000;
export const GUEST_DEADLINE_AFTER_MS = 10_000;

export function createGuestDeadlineOutcome(
  panelKey: PublicPanelKey,
  occurredAt: string,
): InformationOutcome<GuestPanelValue> {
  return {
    status: "failed",
    degradation: {
      code: "timeout",
      provider: "public-composition",
      feed: panelKey,
      occurredAt,
      retryable: true,
      diagnosticReference: brandReference<string, "DiagnosticReference">(`diagnostic:f1-deadline:${panelKey}`),
    },
    policyVersion: brandReference<string, "PolicyVersion">("policy:f1-deadline"),
  };
}

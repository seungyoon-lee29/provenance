import { brandReference } from "../../../../shared/contracts/brands";

import type {
  GuestFinancialInformation,
  GuestFinancialLoad,
  GuestFinancialQuery,
  GuestFinancialUpdates,
} from "./contracts";

export function createPublicFinancialInformation(): GuestFinancialInformation {
  return {
    read(query: GuestFinancialQuery): GuestFinancialLoad {
      return {
        kind: "FinancialLoad",
        cache: "hit",
        query,
        result: Promise.resolve({
          status: "unavailable",
          reason: "api_required",
          requiredCapability: `public_${query.panelKey}`,
          configurationRoute: "/settings/providers",
          policyVersion: brandReference<string, "PolicyVersion">("policy:f1-public"),
        }),
      };
    },
    follow(): GuestFinancialUpdates {
      return { async *[Symbol.asyncIterator]() { return; } };
    },
  };
}

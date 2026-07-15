import fixtureJson from "../../../../../fixtures/spec/f1/guest-information-outcomes.json";
import { brandReference } from "../../../../shared/contracts/brands";
import type { InformationOutcome } from "@/shared";
import { z } from "zod";

import type {
  GuestClock,
  GuestFinancialInformation,
  GuestFinancialLoad,
  GuestFinancialQuery,
  GuestFinancialUpdates,
  GuestFixtureCatalog,
  GuestPanelValue,
} from "./contracts";
import { publicPanelKeys } from "./contracts";

const degradationSchema = z.object({
  code: z.enum(["quota", "timeout", "upstream", "reauthentication_required", "forbidden_upstream", "invalid_response"]),
  provider: z.string().min(1),
  feed: z.string().min(1).optional(),
  occurredAt: z.iso.datetime(),
  retryable: z.boolean(),
  retryAfter: z.iso.datetime().optional(),
  diagnosticReference: z.string().min(1),
}).strict();

const licenseScopeSchema = z.object({
  audience: z.enum(["public", "personal", "internal_test_only"]),
  purposes: z.array(z.string().min(1)).min(1),
  validUntil: z.iso.datetime(),
}).strict();

const availableSchema = z.object({
  status: z.literal("available"),
  value: z.object({ label: z.string().min(1), displayValue: z.string().min(1), unit: z.string().min(1).optional() }).strict(),
  evidenceReference: z.string().min(1),
  provider: z.string().min(1),
  feed: z.string().min(1),
  venue: z.string().min(1).optional(),
  asOf: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  freshness: z.enum(["realtime", "delayed", "stale"]),
  licenseScope: licenseScopeSchema,
  policyVersion: z.string().min(1),
  degradation: degradationSchema.optional(),
}).strict();

const unavailableSchema = z.discriminatedUnion("reason", [
  z.object({
    status: z.literal("unavailable"),
    reason: z.literal("api_required"),
    requiredCapability: z.string().min(1),
    configurationRoute: z.string().startsWith("/"),
    policyVersion: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.literal("license_restricted"),
    source: z.string().min(1),
    purpose: z.string().min(1),
    policyVersion: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.literal("no_data"),
    queryRange: z.string().min(1),
    asOf: z.iso.datetime(),
    policyVersion: z.string().min(1),
  }).strict(),
]);

const fixtureSchema = z.object({
  marker: z.literal("SYNTHETIC TEST DATA"),
  provider: z.literal("synthetic"),
  isSynthetic: z.literal(true),
  licenseScope: licenseScopeSchema,
  cases: z.array(z.object({
    id: z.string().min(1),
    panelKey: z.enum(publicPanelKeys),
    cache: z.enum(["hit", "miss"]),
    settleAfterMs: z.number().nonnegative().nullable().optional(),
    outcome: z.union([availableSchema, unavailableSchema, z.object({
      status: z.literal("failed"),
      degradation: degradationSchema,
      policyVersion: z.string().min(1),
    }).strict()]),
  }).strict()).min(1),
}).strict();

export function loadSyntheticGuestFixture(): GuestFixtureCatalog {
  const fixture = fixtureSchema.parse(fixtureJson);
  return {
    marker: fixture.marker,
    provider: fixture.provider,
    isSynthetic: fixture.isSynthetic,
    cases: fixture.cases.map((fixtureCase) => ({
      ...fixtureCase,
      outcome: fixtureCase.outcome as InformationOutcome<GuestPanelValue>,
    })),
  };
}

function emptyUpdates(): GuestFinancialUpdates {
  return { async *[Symbol.asyncIterator]() { return; } };
}

export function createScriptedFinancialInformation(
  clock: GuestClock,
  hitDelayMs = 0,
): GuestFinancialInformation {
  const fixture = loadSyntheticGuestFixture();
  return {
    read(query: GuestFinancialQuery): GuestFinancialLoad {
      const fixtureCase = fixture.cases.find((candidate) => candidate.panelKey === query.panelKey);
      const fallback: InformationOutcome<GuestPanelValue> = {
        status: "unavailable",
        reason: "api_required",
        requiredCapability: `fixture_${query.panelKey}`,
        configurationRoute: "/settings/providers",
        policyVersion: brandReference<string, "PolicyVersion">("policy:f1-fixture"),
      };
      if (!fixtureCase) return { kind: "FinancialLoad", cache: "hit", query, result: Promise.resolve(fallback) };
      if (fixtureCase.cache === "hit") {
        const result = hitDelayMs === 0
          ? Promise.resolve(fixtureCase.outcome)
          : clock.sleep(hitDelayMs).then(() => fixtureCase.outcome);
        return { kind: "FinancialLoad", cache: "hit", query, result };
      }
      const result = fixtureCase.settleAfterMs == null
        ? new Promise<InformationOutcome<GuestPanelValue>>(() => undefined)
        : clock.sleep(fixtureCase.settleAfterMs).then(() => fixtureCase.outcome);
      return { kind: "FinancialLoad", cache: "miss", query, result };
    },
    follow(): GuestFinancialUpdates {
      return emptyUpdates();
    },
  };
}

import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { WorkspaceReference } from "@/shared/contracts/brands";
import type { SourceReference } from "@/shared/contracts/brands";
import { createOccurrenceStore } from "../src/modules/notification-center/occurrence-engine";
import { planDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import type { PlannedDeliveryIntent } from "../src/modules/notification-center/delivery-intent";
import { DeliveryOutbox } from "../src/modules/notification-center/delivery-outbox";
import { DeliveryFactLog } from "../src/modules/notification-center/delivery-fact";
import { ProviderMessageDirectory } from "../src/modules/notification-center/webhook-inbox";
import { TokenBucket } from "../src/modules/notification-center/email-throttle";
import { DeliveryDispatcher, EmailQuotaLedger } from "../src/modules/notification-center/dispatch-loop";
import { presentInbox } from "../src/modules/notification-center/inbox-presenter";

/**
 * F5 deadline budgets (spec §12 lines 369/395-396, ticket AC): Alert
 * Observation→Occurrence/Record commit p95 ≤ 500 ms, committed eligible
 * Intent→first dispatch claim ≤ 1.5 s, NotificationCenter inbox open
 * 200 ms (warm p95) / 400 ms (cold). Budgets are asserted on real module
 * calls with the scripted lane — they catch pathological regressions
 * (accidental awaits, O(n²) scans), not micro-variance.
 */

const WS = brandReference<string, "WorkspaceReference">("workspace:perf") as WorkspaceReference;
const T0 = Date.parse("2026-01-02T10:00:00.000Z");
const source: SourceReference = brandReference<string, "SourceReference">("source:evidence:perf");

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function intentFor(rule: string, seq: number): PlannedDeliveryIntent {
  const outcome = planDeliveryIntent({
    cause: { kind: "alert_occurrence", causeId: brandReference<string, "DeliveryCauseId">(`cause:alert:${rule}:${seq}`) },
    channel: "web_push",
    source,
    target: {
      kind: "workspace_web_push",
      reference: brandReference<string, "DeliveryDestinationReference">(`dest:push:${rule}:${seq}`),
      destinationFingerprint: `fp:push:${rule}:${seq}`,
    },
    binding: { templateRevision: "tpl-perf", payloadHash: "hash-perf", expiresAt: new Date(T0 + 3_600_000).toISOString() },
  });
  if (outcome.status !== "planned") throw new Error("perf intent rejected");
  return outcome.intent;
}

describe("F5 deadline budgets (fixed scripted lane)", () => {
  it("alert observation → occurrence/record commit stays under 500 ms p95", async () => {
    const store = createOccurrenceStore(() => new Date(T0).toISOString());
    store.registerRule({ ruleReference: brandReference<string, "AlertRuleReference">("rule:perf"), workspaceReference: WS, conditionRevision: "rev-1" });
    const samples: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const startedAt = performance.now();
      // alternate false→true so every second observation is a real transition commit
      await store.observe({
        ruleReference: brandReference<string, "AlertRuleReference">("rule:perf"),
        conditionRevision: "rev-1",
        conditionMet: index % 2 === 0,
        sourceObservationIdentity: index + 1,
        asOf: new Date(T0 + index).toISOString(),
      });
      samples.push(performance.now() - startedAt);
    }
    expect(p95(samples)).toBeLessThanOrEqual(500);
  });

  it("committed eligible intent → first dispatch claim stays under 1.5 s", async () => {
    const outbox = new DeliveryOutbox();
    const facts = new DeliveryFactLog();
    const claimLatencies: number[] = [];
    let committedAt = 0;
    const dispatcher = new DeliveryDispatcher({
      outbox,
      facts,
      directory: new ProviderMessageDirectory(),
      authorize: () => ({ status: "authorized" }),
      email: {
        adapter: { route: { provider: "resend", environment: "test" }, send: () => ({ status: "accepted", providerMessageId: "pm-perf" }) },
        quota: new EmailQuotaLedger(),
        health: () => ({ metrics: { sampleSize: 1000, hardBounces: 0, complaints: 0 }, manualApproval: false }),
        addressState: () => ({ hardBounced: false, reVerified: false, complained: false }),
        inQuietHours: () => false,
        bucket: new TokenBucket(10_000, 10_000, T0),
      },
      push: {
        send: () => {
          claimLatencies.push(performance.now() - committedAt);
          return { kind: "status", code: 201 };
        },
      },
    });
    for (let seq = 1; seq <= 50; seq += 1) {
      committedAt = performance.now();
      outbox.commit(String(WS), intentFor("rule:perf", seq), 1);
      await dispatcher.dispatchTick(String(WS), T0 + seq);
    }
    expect(claimLatencies).toHaveLength(50);
    expect(p95(claimLatencies)).toBeLessThanOrEqual(1_500);
  });

  it("inbox open (records + facts → view) stays under 200 ms warm / 400 ms cold p95 with 500 records", async () => {
    const store = createOccurrenceStore(() => new Date(T0).toISOString());
    const facts = new DeliveryFactLog();
    for (let rule = 0; rule < 500; rule += 1) {
      const ruleReference = brandReference<string, "AlertRuleReference">(`rule:open:${rule}`);
      store.registerRule({ ruleReference, workspaceReference: WS, conditionRevision: "rev-1" });
      const result = await store.observe({
        ruleReference,
        conditionRevision: "rev-1",
        conditionMet: true,
        sourceObservationIdentity: 1,
        asOf: new Date(T0 + rule).toISOString(),
      });
      if (result.kind === "transition") {
        facts.append(String(WS), { causeId: result.record.causeId, intentUniqueKey: `${String(result.record.causeId)}|email|fp`, kind: "provider_accepted", occurredAt: new Date(T0).toISOString() }, 1);
      }
    }
    const open = () => {
      const startedAt = performance.now();
      const view = presentInbox(store.listRecords(WS), facts.list(String(WS)));
      const elapsed = performance.now() - startedAt;
      expect(view.cards).toHaveLength(500);
      return elapsed;
    };
    const cold = open();
    const warm: number[] = [];
    for (let index = 0; index < 50; index += 1) warm.push(open());
    expect(cold).toBeLessThanOrEqual(400);
    expect(p95(warm)).toBeLessThanOrEqual(200);
  });
});

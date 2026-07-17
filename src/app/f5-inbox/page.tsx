import { notFound } from "next/navigation";

import { brandReference } from "@/shared/contracts/brands";
import type { WorkspaceReference } from "@/shared/contracts/brands";
import type { SourceReference } from "@/shared/contracts/brands";

import { createOccurrenceStore } from "@/modules/notification-center/occurrence-engine";
import type { AlertObservation } from "@/modules/notification-center/contracts";
import { planDeliveryIntent } from "@/modules/notification-center/delivery-intent";
import type { DeliveryIntentRequest, PlannedDeliveryIntent } from "@/modules/notification-center/delivery-intent";
import { DeliveryOutbox } from "@/modules/notification-center/delivery-outbox";
import { DeliveryFactLog } from "@/modules/notification-center/delivery-fact";
import { ProviderMessageDirectory } from "@/modules/notification-center/webhook-inbox";
import { TokenBucket } from "@/modules/notification-center/email-throttle";
import { DeliveryDispatcher, EmailQuotaLedger } from "@/modules/notification-center/dispatch-loop";
import { presentInbox } from "@/modules/notification-center/inbox-presenter";
import type { InboxTone } from "@/modules/notification-center/inbox-presenter";

export const dynamic = "force-dynamic";

// Synthetic acceptance surface for F5 (AT-10 / UF-08 / WS-06). Runs the REAL
// occurrence engine, outbox, dispatcher and presenter over scripted network-off
// adapters, so the browser asserts the exactly-once and no-promotion invariants
// against actual DOM. Contained to non-production, SYNTHETIC data only.
function devOnly(): void {
  if (process.env.APP_ENVIRONMENT === "production") notFound();
}

const WS = brandReference<string, "WorkspaceReference">("workspace:w-demo") as WorkspaceReference;
const SUBJECT = String(WS);
const T0 = Date.parse("2026-01-02T10:00:00.000Z");
const source: SourceReference = brandReference<string, "SourceReference">("source:evidence:demo");

function observation(rule: string, identity: number): AlertObservation {
  return {
    ruleReference: brandReference<string, "AlertRuleReference">(rule),
    conditionRevision: "rev-1",
    conditionMet: true,
    sourceObservationIdentity: identity,
    asOf: new Date(T0 - identity).toISOString(),
  };
}

function financialIntent(causeId: string, channel: "email" | "web_push"): PlannedDeliveryIntent {
  const request: DeliveryIntentRequest = {
    cause: { kind: "alert_occurrence", causeId: brandReference<string, "DeliveryCauseId">(causeId) },
    channel,
    source,
    ...(channel === "email"
      ? { actionMaterial: { kind: "unsubscribe" as const, reference: brandReference<string, "DeliveryActionMaterialReference">("mat:unsub-demo") } }
      : {}),
    target: channel === "email"
      ? { kind: "workspace_financial_email", reference: brandReference<string, "DeliveryDestinationReference">("dest:email-demo"), destinationFingerprint: `fp:email:${causeId}` }
      : { kind: "workspace_web_push", reference: brandReference<string, "DeliveryDestinationReference">("dest:push-demo"), destinationFingerprint: `fp:push:${causeId}` },
    binding: { templateRevision: "tpl-demo-1", payloadHash: "hash-demo", expiresAt: new Date(T0 + 3_600_000).toISOString() },
  };
  const outcome = planDeliveryIntent(request);
  if (outcome.status !== "planned") throw new Error(`synthetic intent rejected: ${outcome.reason}`);
  return outcome.intent;
}

async function buildInbox() {
  const store = createOccurrenceStore(() => new Date(T0).toISOString());
  for (const rule of ["rule:hundred", "rule:inapp", "rule:pushfail", "rule:delayed"]) {
    store.registerRule({ ruleReference: brandReference<string, "AlertRuleReference">(rule), workspaceReference: WS, conditionRevision: "rev-1" });
  }

  // AT-10: 100 concurrent observations of the SAME transition → exactly one
  // occurrence/record; the other three rules transition once each.
  const hundred = await Promise.all(Array.from({ length: 100 }, () => store.observe(observation("rule:hundred", 1))));
  const transitions = hundred.filter((result) => result.kind === "transition").length;
  await store.observe(observation("rule:inapp", 1));
  await store.observe(observation("rule:pushfail", 1));
  await store.observe(observation("rule:delayed", 1));

  const outbox = new DeliveryOutbox();
  const facts = new DeliveryFactLog();
  const directory = new ProviderMessageDirectory();
  const dispatcher = new DeliveryDispatcher({
    outbox,
    facts,
    directory,
    // Synthetic surface only: the production worker injects the B2 resolvers
    // here (SEC-06); this page has no real Delivery Authorization state.
    authorize: () => ({ status: "authorized" }),
    email: {
      adapter: {
        route: { provider: "resend", environment: "synthetic" },
        send: ({ intent }) => (String(intent.cause.causeId).includes("rule:delayed")
          ? { status: "rate_limited", retryAfterSeconds: 300 }
          : { status: "accepted", providerMessageId: `pm-${intent.uniqueKey}` }),
      },
      quota: new EmailQuotaLedger(),
      health: () => ({ metrics: { sampleSize: 1000, hardBounces: 0, complaints: 0 }, manualApproval: false }),
      addressState: () => ({ hardBounced: false, reVerified: false, complained: false }),
      inQuietHours: () => false,
      bucket: new TokenBucket(100, 100, T0),
    },
    push: { send: () => ({ kind: "status", code: 400 }) },
  });

  const records = store.listRecords(WS);
  const causeOf = (rule: string) => String(records.find((record) => String(record.causeId).includes(rule))?.causeId ?? "");
  outbox.commit(SUBJECT, financialIntent(causeOf("rule:hundred"), "email"), 1);
  outbox.commit(SUBJECT, financialIntent(causeOf("rule:pushfail"), "web_push"), 1);
  outbox.commit(SUBJECT, financialIntent(causeOf("rule:delayed"), "email"), 1);
  await dispatcher.dispatchTick(SUBJECT, T0);

  const view = presentInbox(store.listRecords(WS), facts.list(SUBJECT));
  return { view, transitions, recordCount: records.length, occurrenceCount: store.listOccurrences(brandReference<string, "AlertRuleReference">("rule:hundred")).length };
}

const TONE_COLOR: Record<InboxTone, string> = {
  progress: "#6ea8fe",
  done: "#75b798",
  muted: "#adb5bd",
  problem: "#ea868f",
  none: "#dee2e6",
};

export default async function F5InboxPage() {
  devOnly();
  const { view, transitions, recordCount, occurrenceCount } = await buildInbox();

  return (
    <main style={{ padding: "12px", boxSizing: "border-box" }} aria-label="F5 알림 inbox" data-surface="f5-inbox">
      <div role="note" data-role="synthetic-marker">
        <strong>SYNTHETIC TEST DATA</strong>
        <span> · INTERNAL TEST ONLY · 실제 알림 아님</span>
      </div>

      <p
        role="status"
        aria-live="polite"
        data-role="inbox-announcement"
        data-transition-count={transitions}
        data-occurrence-count={occurrenceCount}
        data-record-count={recordCount}
      >
        {view.announcement}
      </p>

      <section aria-label="알림 목록" data-group="inbox">
        {view.cards.map((card) => (
          <article
            key={card.recordKey}
            data-record-key={card.recordKey}
            data-status={card.deliveryStatus}
            data-tone={card.deliveryTone}
            style={{ borderLeft: `4px solid ${TONE_COLOR[card.deliveryTone]}`, margin: "8px 0", padding: "8px" }}
          >
            <h2 style={{ fontSize: "1rem", margin: 0 }}>{card.causeId}</h2>
            <p data-role="delivery-status" style={{ margin: "4px 0" }}>{card.deliveryStatusLabel}</p>
            <p data-role="read-state" style={{ margin: 0 }}>{card.read ? "읽음" : "읽지 않음"}</p>
            <time dateTime={card.triggeredAt}>{card.triggeredAt}</time>
          </article>
        ))}
      </section>
    </main>
  );
}

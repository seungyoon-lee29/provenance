import type { NotificationRecord } from "./contracts";
import type { DeliveryFact, DeliveryFactKind } from "./delivery-fact";
import { projectDeliveryStatus } from "./delivery-fact";

/**
 * F5 in-app inbox presenter (UF-08, WS-06). Pure projection of the canonical
 * Notification Records plus the append-only Delivery Facts of their causes.
 * Every status is a NAME (never color alone) and the external delivery status
 * is the promotion-free `projectDeliveryStatus` — a provider acceptance is
 * presented as acceptance, "전달됨/확인됨" appear only for recorded facts.
 */

export type InboxTone = "progress" | "done" | "muted" | "problem" | "none";

const STATUS_PRESENTATION: Record<DeliveryFactKind | "none", Readonly<{ label: string; tone: InboxTone }>> = {
  none: { label: "인앱 표시", tone: "none" },
  queued: { label: "발송 대기", tone: "progress" },
  delayed: { label: "재시도 예정", tone: "progress" },
  provider_accepted: { label: "발송 접수", tone: "progress" },
  delivered: { label: "전달됨", tone: "done" },
  seen: { label: "확인됨", tone: "done" },
  bounced: { label: "반송됨", tone: "problem" },
  complained: { label: "수신 거부 신고", tone: "problem" },
  provider_suppressed: { label: "제공자 억제", tone: "muted" },
  suppressed: { label: "억제됨", tone: "muted" },
  failed: { label: "발송 실패", tone: "problem" },
  expired: { label: "만료됨", tone: "muted" },
};

export type InboxCardView = Readonly<{
  recordKey: string;
  causeId: string;
  triggeredAt: string;
  read: boolean;
  deliveryStatus: DeliveryFactKind | "none";
  deliveryStatusLabel: string;
  deliveryTone: InboxTone;
}>;

export type InboxView = Readonly<{
  totalCount: number;
  unreadCount: number;
  /** aria-live announcement text for the inbox surface. */
  announcement: string;
  /** Newest first; dismissed records are acknowledged out of the visible list. */
  cards: readonly InboxCardView[];
}>;

export function presentInbox(records: readonly NotificationRecord[], facts: readonly DeliveryFact[]): InboxView {
  const factsByCause = new Map<string, DeliveryFact[]>();
  for (const fact of facts) {
    const key = String(fact.causeId);
    const bucket = factsByCause.get(key);
    if (bucket === undefined) factsByCause.set(key, [fact]);
    else bucket.push(fact);
  }

  const visible = records
    .filter((record) => !record.dismissed)
    .sort((left, right) => right.triggeredAt.localeCompare(left.triggeredAt) || String(right.recordReference).localeCompare(String(left.recordReference)));

  const cards = visible.map((record): InboxCardView => {
    const status = projectDeliveryStatus(factsByCause.get(String(record.causeId)) ?? []);
    const presentation = STATUS_PRESENTATION[status];
    return {
      recordKey: String(record.recordReference),
      causeId: String(record.causeId),
      triggeredAt: record.triggeredAt,
      read: record.read,
      deliveryStatus: status,
      deliveryStatusLabel: presentation.label,
      deliveryTone: presentation.tone,
    };
  });

  const unreadCount = cards.filter((card) => !card.read).length;
  return {
    totalCount: records.length,
    unreadCount,
    announcement: `읽지 않은 알림 ${unreadCount}건, 전체 ${records.length}건`,
    cards,
  };
}

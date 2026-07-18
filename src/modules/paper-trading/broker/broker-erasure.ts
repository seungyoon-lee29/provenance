import type { Erasable } from "../../notification-center/fenced-store";

import type { BrokerPaperBook } from "./book";
import type { BrokerOutbox, BrokerPendingSubmissions } from "./outbox";
import type { BrokerPaperTradingService } from "./service";

/**
 * F9 extension of the PaperTrading erasure receipt (SEC-09; ticket 18): the
 * broker book (orders, events, quarantine, receipts), the durable outbox, the
 * PendingBrokerSubmission worklist and the broker order intents all join the
 * SAME `PaperTradingErasure` participant as labelled Erasable stores — one
 * coordinator fence, one module receipt, restore suppression included. No new
 * erasure machinery: registration is the extension.
 */
export function brokerErasables(
  book: BrokerPaperBook,
  outbox: BrokerOutbox,
  pending: BrokerPendingSubmissions,
  service: BrokerPaperTradingService,
): readonly Readonly<{ label: string; store: Erasable }>[] {
  return [
    { label: "broker-book", store: { eraseSubject: (subject, fence) => book.eraseWorkspace(subject, fence) } },
    { label: "broker-outbox", store: outbox },
    { label: "broker-pending-submissions", store: pending },
    ...service.erasableStores(),
  ];
}

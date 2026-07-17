import type { InternalPaperAccountReference, PaperOrderReference } from "../../../shared/contracts/brands";

import type { PaperMoney } from "./contracts";
import type { PaperJournalEntry } from "./journal";

/**
 * F8 Paper Blotter presentation (spec §9, UF-07): the account's Paper record
 * in journal-time order — submit, simulated fill (with BOTH the market event
 * time and receipt time), cancellation resolution, expiry and lifecycle
 * events. The kind union is closed over Internal Paper entries only: an
 * Actual or Live record has no representation here by construction (ADR A04).
 */

export type PaperBlotterRow = Readonly<{
  revision: number;
  at: string;
  account: InternalPaperAccountReference;
  kind: "submit" | "fill" | "cancel_confirmed" | "cancel_rejected" | "expiry" | "corporate_action" | "dividend";
  order?: PaperOrderReference;
  quantity?: number;
  price?: PaperMoney;
  eventTime?: string;
  receivedAt?: string;
  detail: string;
}>;

export function presentBlotter(entries: readonly PaperJournalEntry[]): readonly PaperBlotterRow[] {
  const rows: PaperBlotterRow[] = [];
  for (const entry of entries) {
    const base = { revision: entry.revision, at: entry.recordedAt, account: entry.account };
    switch (entry.kind) {
      case "order_submitted":
        rows.push({
          ...base,
          kind: "submit",
          order: entry.order,
          quantity: entry.payload.quantity,
          price: entry.payload.limitPrice,
          detail: `${entry.payload.side} ${entry.payload.quantity} ${String(entry.payload.instrument)} ${entry.payload.orderType} ${entry.payload.timeInForce}`,
        });
        break;
      case "fill_applied":
        rows.push({
          ...base,
          kind: "fill",
          order: entry.fill.order,
          quantity: entry.fill.quantity,
          price: entry.fill.price,
          eventTime: entry.fill.eventTime,
          receivedAt: entry.fill.receivedAt,
          detail: `simulated fill ${entry.fill.quantity} @ ${entry.fill.price.amount} ${entry.fill.price.currency} (${entry.fill.policyVersion})`,
        });
        break;
      case "cancellation_resolved":
        rows.push({
          ...base,
          kind: entry.resolution === "confirmed" ? "cancel_confirmed" : "cancel_rejected",
          order: entry.order,
          detail: `cancellation ${entry.resolution}`,
        });
        break;
      case "order_expired":
        rows.push({ ...base, kind: "expiry", order: entry.order, detail: "DAY order expired" });
        break;
      case "corporate_action_applied":
        rows.push({
          ...base,
          kind: "corporate_action",
          detail: `${String(entry.instrument)} split ${entry.adjustment.numerator}:${entry.adjustment.denominator}`,
        });
        break;
      case "dividend_applied":
        rows.push({
          ...base,
          kind: "dividend",
          detail: `${String(entry.instrument)} dividend ${entry.perShare.amount} ${entry.perShare.currency}/share`,
        });
        break;
      case "account_opened":
        break;
    }
  }
  return rows;
}

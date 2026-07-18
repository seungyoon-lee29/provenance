import type { BrokerPaperAccountReference, ProviderConnectionReference } from "@/shared/contracts/brands";

import { FencedKeyedStore } from "../../notification-center/fenced-store";
import type { BrokerClientOrderReference, BrokerPaperOrderIntentReference } from "./contracts";

/**
 * F9 durable-before-send substrate (spec §9, AT-08): the outbox row and the
 * PendingBrokerSubmission worklist entry are committed in the same synchronous
 * section as the local order — BEFORE any route call — so a crash or timeout
 * can never lose the fact that a dispatch may have happened. Both stores sit
 * on the fenced substrate (SEC-09).
 */

export type BrokerOutboxRowKind = "submit" | "cancel";
/**
 * `pending_dispatch` → `dispatched` (route call in flight or crashed mid-call:
 * Submission Uncertainty) → `acknowledged` | `closed` (definite terminal).
 */
export type BrokerOutboxRowState = "pending_dispatch" | "dispatched" | "acknowledged" | "closed";

export type BrokerOutboxRow = Readonly<{
  kind: BrokerOutboxRowKind;
  account: BrokerPaperAccountReference;
  connection: ProviderConnectionReference;
  clientOrder: BrokerClientOrderReference;
  intent?: BrokerPaperOrderIntentReference;
  state: BrokerOutboxRowState;
  attempts: number;
}>;

export type BrokerOutboxCommitResult =
  | Readonly<{ status: "committed" }>
  | Readonly<{ status: "duplicate" }>
  | Readonly<{ status: "suppressed" }>;

function rowKey(account: BrokerPaperAccountReference, clientOrder: BrokerClientOrderReference, kind: BrokerOutboxRowKind): string {
  return `${String(account)}|${String(clientOrder)}|${kind}`;
}

export class BrokerOutbox {
  readonly #rows = new FencedKeyedStore<BrokerOutboxRow>();

  commit(workspace: string, row: BrokerOutboxRow, atEpoch: number): BrokerOutboxCommitResult {
    const { written, value } = this.#rows.writeIfAbsent(workspace, rowKey(row.account, row.clientOrder, row.kind), row, atEpoch);
    if (value === undefined) return { status: "suppressed" };
    return { status: written ? "committed" : "duplicate" };
  }

  get(workspace: string, account: BrokerPaperAccountReference, clientOrder: BrokerClientOrderReference, kind: BrokerOutboxRowKind): BrokerOutboxRow | undefined {
    return this.#rows.get(workspace, rowKey(account, clientOrder, kind));
  }

  /** Monotonic state advance; a write below the fence is suppressed and returns false. */
  transition(
    workspace: string,
    account: BrokerPaperAccountReference,
    clientOrder: BrokerClientOrderReference,
    kind: BrokerOutboxRowKind,
    from: readonly BrokerOutboxRowState[],
    to: BrokerOutboxRowState,
    atEpoch: number,
  ): boolean {
    const key = rowKey(account, clientOrder, kind);
    const row = this.#rows.get(workspace, key);
    if (row === undefined || !from.includes(row.state)) return false;
    return this.#rows.write(workspace, key, { ...row, state: to, attempts: row.attempts + (to === "dispatched" ? 1 : 0) }, atEpoch);
  }

  list(workspace: string): readonly BrokerOutboxRow[] {
    return this.#rows.list(workspace);
  }

  eraseSubject(workspace: string, fence: number): number {
    return this.#rows.eraseSubject(workspace, fence);
  }
}

export type PendingBrokerSubmission = Readonly<{
  account: BrokerPaperAccountReference;
  connection: ProviderConnectionReference;
  clientOrder: BrokerClientOrderReference;
  intent: BrokerPaperOrderIntentReference;
  since: string;
}>;

export class BrokerPendingSubmissions {
  readonly #rows = new FencedKeyedStore<PendingBrokerSubmission>();

  commit(workspace: string, row: PendingBrokerSubmission, atEpoch: number): BrokerOutboxCommitResult {
    const { written, value } = this.#rows.writeIfAbsent(workspace, String(row.clientOrder), row, atEpoch);
    if (value === undefined) return { status: "suppressed" };
    return { status: written ? "committed" : "duplicate" };
  }

  list(workspace: string): readonly PendingBrokerSubmission[] {
    return this.#rows.list(workspace);
  }

  eraseSubject(workspace: string, fence: number): number {
    return this.#rows.eraseSubject(workspace, fence);
  }
}

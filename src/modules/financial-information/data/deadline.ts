import type { InformationOutcome } from "@/shared";

import { classifyProviderFailure } from "./outcome-classification";

export const DATA_DEADLINE_MS = 10_000; // market/chart/news/filing (§11.3)
export const AI_DEADLINE_MS = 20_000; // ResearchAssistant (§11.3)

export type Sleep = (durationMs: number, signal?: AbortSignal) => Promise<void>;

/**
 * Resolve `work` or, after `deadlineMs`, a normalized timeout outcome — so the
 * surface never shows an infinite spinner (§11.3). The loser's timer is
 * cancelled via AbortController so no dangling handle is left behind.
 */
export async function withDeadline<T>(
  work: Promise<InformationOutcome<T>>,
  input: Readonly<{ deadlineMs: number; sleep: Sleep; onTimeout: () => InformationOutcome<T> }>,
): Promise<InformationOutcome<T>> {
  const controller = new AbortController();
  const timeout = input.sleep(input.deadlineMs, controller.signal).then(
    () => ({ kind: "timeout" as const }),
    () => ({ kind: "aborted" as const }),
  );
  const raced = await Promise.race([
    work.then((outcome) => ({ kind: "work" as const, outcome })),
    timeout,
  ]);
  if (raced.kind === "work") {
    controller.abort();
    return raced.outcome;
  }
  return input.onTimeout();
}

/** Standard timeout outcome for a data feed that missed its deadline (retryable). */
export function deadlineTimeoutOutcome<T>(provider: string, feed: string, occurredAt: string): InformationOutcome<T> {
  return classifyProviderFailure({ failure: { kind: "timeout" }, provider, feed, occurredAt }) as InformationOutcome<T>;
}

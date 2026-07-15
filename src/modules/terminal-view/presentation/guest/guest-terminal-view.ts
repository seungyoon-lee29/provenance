import type {
  GuestClock,
  GuestFinancialInformation,
  GuestFinancialLoad,
  GuestPanelState,
  GuestPanelUpdate,
  GuestSessionProof,
  GuestTerminalLoad,
  GuestTerminalRequest,
  GuestTerminalView,
  PublicPanelKey,
} from "./contracts";
import {
  createGuestDeadlineOutcome,
  GUEST_DEADLINE_AFTER_MS,
  GUEST_WAITING_AFTER_MS,
} from "./guest-deadline";

export const guestSystemClock: GuestClock = {
  now: () => Date.now(),
  sleep(durationMs, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("guest terminal load cancelled"));
        return;
      }
      const timer = setTimeout(resolve, durationMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("guest terminal load cancelled"));
      }, { once: true });
    });
  },
};

export function createGuestTerminalRequest(
  requestedPanels: readonly PublicPanelKey[],
  requestRevision: string,
): GuestTerminalRequest {
  return { kind: "TerminalRequest", mode: "guest", requestedPanels: [...new Set(requestedPanels)], requestRevision };
}

export function createGuestSessionProof(requestId: string): GuestSessionProof {
  if (requestId.trim().length === 0) throw new Error("guest request id must not be empty");
  return { kind: "SessionProof", source: "server_guest", requestId };
}

async function* streamPanel(
  load: GuestFinancialLoad,
  clock: GuestClock,
  openedAt: number,
  resumeIdentity: string,
  signal: AbortSignal,
): AsyncIterable<GuestPanelUpdate> {
  const { panelKey, requestRevision } = load.query;
  const sleepUntil = (elapsedMs: number): Promise<void> => {
    const remainingMs = Math.max(0, elapsedMs - Math.max(0, clock.now() - openedAt));
    return remainingMs === 0 ? Promise.resolve() : clock.sleep(remainingMs, signal);
  };
  const first = await Promise.race([
    load.result.then((outcome) => ({ kind: "result" as const, outcome })),
    sleepUntil(GUEST_WAITING_AFTER_MS).then(() => ({ kind: "waiting" as const })),
  ]);
  if (first.kind === "result") {
    yield {
      panelKey,
      requestRevision,
      sequence: 1,
      resumeIdentity,
      completed: true,
      state: { panelKey, state: "ready", outcome: first.outcome, requestRevision },
    };
    return;
  }

  yield {
    panelKey,
    requestRevision,
    sequence: 1,
    resumeIdentity,
    completed: false,
    state: { panelKey, state: "pending", phase: "provider_wait", since: clock.now(), requestRevision },
  };

  const second = await Promise.race([
    load.result.then((outcome) => ({ kind: "result" as const, outcome })),
    sleepUntil(GUEST_DEADLINE_AFTER_MS).then(() => ({ kind: "deadline" as const })),
  ]);
  const outcome = second.kind === "result"
    ? second.outcome
    : createGuestDeadlineOutcome(panelKey, new Date(clock.now()).toISOString());
  yield {
    panelKey,
    requestRevision,
    sequence: 2,
    resumeIdentity,
    completed: true,
    state: { panelKey, state: "ready", outcome, requestRevision },
  };
}

async function* mergeUpdates(streams: readonly AsyncIterable<GuestPanelUpdate>[]): AsyncIterable<GuestPanelUpdate> {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<Readonly<{ index: number; result: IteratorResult<GuestPanelUpdate> }>>>();
  for (const [index, iterator] of iterators.entries()) {
    pending.set(index, iterator.next().then((result) => ({ index, result })));
  }
  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(index);
      continue;
    }
    yield result.value;
    const iterator = iterators[index];
    if (!iterator) throw new Error("guest update iterator disappeared");
    pending.set(index, iterator.next().then((nextResult) => ({ index, result: nextResult })));
  }
}

export function createGuestTerminalView(options: Readonly<{
  financialInformation: GuestFinancialInformation;
  clock?: GuestClock;
  syntheticMarker?: "SYNTHETIC TEST DATA";
}>): GuestTerminalView {
  const clock = options.clock ?? guestSystemClock;
  return {
    open(request: GuestTerminalRequest, proof: GuestSessionProof): GuestTerminalLoad {
      if (proof.source !== "server_guest") throw new Error("guest proof must be issued by the server");
      const openedAt = clock.now();
      const viewer = { kind: "guest" as const, requestId: proof.requestId };
      const loads = request.requestedPanels.map((panelKey) => options.financialInformation.read({
        kind: "FinancialQuery",
        panelKey,
        purpose: "public_display",
        requestRevision: request.requestRevision,
      }, viewer));
      const controller = new AbortController();
      const resumeIdentity = `guest:${crypto.randomUUID()}`;
      const initial = Promise.all(loads.map(async (load): Promise<GuestPanelState> => {
        if (load.cache === "miss") {
          return {
            panelKey: load.query.panelKey,
            state: "pending",
            phase: "initial",
            since: openedAt,
            requestRevision: request.requestRevision,
          };
        }
        return {
          panelKey: load.query.panelKey,
          state: "ready",
          outcome: await load.result,
          requestRevision: request.requestRevision,
        };
      })).then((panels) => ({
        requestRevision: request.requestRevision,
        safetyDeadlineAfterMs: Math.max(0, GUEST_DEADLINE_AFTER_MS - Math.max(0, clock.now() - openedAt)),
        panels,
        access: [
          { state: "login_required" as const, feature: "portfolio" as const },
          { state: "login_required" as const, feature: "paper_trading" as const },
          { state: "login_required" as const, feature: "ai" as const },
          { state: "login_required" as const, feature: "alerts" as const },
        ],
        ...(options.syntheticMarker ? { syntheticMarker: options.syntheticMarker } : {}),
      }));
      const missed = loads.filter((load) => load.cache === "miss");
      return {
        kind: "TerminalLoad",
        initial,
        updates: mergeUpdates(missed.map((load) => streamPanel(
          load,
          clock,
          openedAt,
          resumeIdentity,
          controller.signal,
        ))),
        resumeIdentity,
        cancel: () => controller.abort(),
      };
    },
  };
}

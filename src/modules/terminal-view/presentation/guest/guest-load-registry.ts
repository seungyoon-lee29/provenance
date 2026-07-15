import "server-only";

import type { GuestTerminalLoad } from "./contracts";

const LOAD_HANDOFF_TTL_MS = 15_000;

type LoadHandoff = Readonly<{
  load: GuestTerminalLoad;
  requestRevision: string;
  expires: ReturnType<typeof setTimeout>;
}>;

type GuestLoadRegistryGlobal = typeof globalThis & {
  __fakeBloombergGuestLoadHandoffs?: Map<string, LoadHandoff>;
};

const registryGlobal = globalThis as GuestLoadRegistryGlobal;
const handoffs = registryGlobal.__fakeBloombergGuestLoadHandoffs
  ?? new Map<string, LoadHandoff>();
registryGlobal.__fakeBloombergGuestLoadHandoffs = handoffs;

export function registerGuestTerminalLoad(
  requestId: string,
  requestRevision: string,
  load: GuestTerminalLoad,
): void {
  const previous = handoffs.get(requestId);
  if (previous) {
    clearTimeout(previous.expires);
    previous.load.cancel();
  }
  const expires = setTimeout(() => {
    const current = handoffs.get(requestId);
    if (current?.load !== load) return;
    handoffs.delete(requestId);
    load.cancel();
  }, LOAD_HANDOFF_TTL_MS);
  expires.unref?.();
  handoffs.set(requestId, { load, requestRevision, expires });
}

export function takeGuestTerminalLoad(
  requestId: string,
  requestRevision: string,
): GuestTerminalLoad | undefined {
  const handoff = handoffs.get(requestId);
  if (!handoff || handoff.requestRevision !== requestRevision) return undefined;
  handoffs.delete(requestId);
  clearTimeout(handoff.expires);
  return handoff.load;
}

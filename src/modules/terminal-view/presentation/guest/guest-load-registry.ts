import "server-only";

import type { GuestTerminalLoad } from "./contracts";

const LOAD_HANDOFF_TTL_MS = 15_000;

type LoadHandoff = Readonly<{
  load: GuestTerminalLoad;
  requestRevision: string;
  /** 개인(KIS) 값이 흐르는 핸드오프의 소유 계정. 공개 게스트 로드는 undefined. */
  ownerAccountReference?: string;
  expires: ReturnType<typeof setTimeout>;
}>;

type GuestLoadRegistryGlobal = typeof globalThis & {
  __provenanceGuestLoadHandoffs?: Map<string, LoadHandoff>;
};

const registryGlobal = globalThis as GuestLoadRegistryGlobal;
const handoffs = registryGlobal.__provenanceGuestLoadHandoffs
  ?? new Map<string, LoadHandoff>();
registryGlobal.__provenanceGuestLoadHandoffs = handoffs;

export function registerGuestTerminalLoad(
  requestId: string,
  requestRevision: string,
  load: GuestTerminalLoad,
  ownerAccountReference?: string,
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
  handoffs.set(requestId, {
    load,
    requestRevision,
    ...(ownerAccountReference === undefined ? {} : { ownerAccountReference }),
    expires,
  });
}

/**
 * 개인 값이 흐르는 핸드오프는 **그 세션의 계정**만 집어갈 수 있다(ticket 36, map line 16). 계정이
 * 어긋난 요청은 핸드오프를 소모하지 않는다 — 남의 요청 하나로 소유자의 스트림을 지워버릴 수 있으면
 * 그 자체가 서비스 거부다.
 */
export function takeGuestTerminalLoad(
  requestId: string,
  requestRevision: string,
  claimAccountReference?: string,
): GuestTerminalLoad | undefined {
  const handoff = handoffs.get(requestId);
  if (!handoff || handoff.requestRevision !== requestRevision) return undefined;
  if (handoff.ownerAccountReference !== undefined && handoff.ownerAccountReference !== claimAccountReference) {
    return undefined;
  }
  handoffs.delete(requestId);
  clearTimeout(handoff.expires);
  return handoff.load;
}

import type { ProviderConnectionReference } from "../../../shared/contracts/brands";
import type { WorkspaceViewerContext } from "../../../shared/contracts/viewer-context";
import type { AuthorizedTransport, ProviderAuthorization } from "../../../platform/provider-transport";

import { BROKER_READ_PURPOSE } from "./routes";

/**
 * F10 broker read-only transport façade (SEC-04, SEC-06, SEC-10): the ONLY door
 * the sync worker has to a real broker. Every transport is minted through the F0
 * `ProviderAuthorization` primitive with the fixed `broker_read` purpose, so
 * connection state, live environment, capability, credential generation,
 * lifecycle fence and the read-only route allowlist are all enforced by the
 * primitive — authorize fails closed the instant a revoke/rotation commits
 * (generation-first), and there is no mutation route to reach.
 */
export class BrokerReadTransport {
  constructor(private readonly deps: Readonly<{ authorization: Pick<ProviderAuthorization, "authorize"> }>) {}

  authorize(connection: ProviderConnectionReference, viewer: WorkspaceViewerContext): Promise<AuthorizedTransport> {
    return this.deps.authorization.authorize(connection, BROKER_READ_PURPOSE, viewer);
  }
}

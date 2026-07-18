import type { ProviderConnectionReference } from "../../../shared/contracts/brands";
import type { WorkspaceViewerContext } from "../../../shared/contracts/viewer-context";
import type { AuthorizedTransport, ProviderAuthorization } from "../../../platform/provider-transport";

import { PAPER_ORDER_PURPOSE } from "./routes";

/**
 * F9 paper-only transport facade (SEC-04, SEC-10): the ONLY door the broker
 * dispatcher has to the network. Every transport is minted through the F0
 * `ProviderAuthorization` primitive with the fixed `paper_order` purpose, so
 * connection state, environment, capability, credential generation, lifecycle
 * fence and the four-route allowlist are all enforced by the primitive —
 * authorize fails closed the moment a revoke/rotation commits
 * (generation-first), and `commitWhileCurrent` fences any late local commit.
 */
export class PaperOrderTransport {
  constructor(
    private readonly deps: Readonly<{
      authorization: Pick<ProviderAuthorization, "authorize">;
      /** Whether this provider guarantees a lookup/idempotency horizon (§9 lookup-before-retry). */
      lookupHorizonGuaranteed: boolean;
    }>,
  ) {}

  get horizonGuaranteed(): boolean {
    return this.deps.lookupHorizonGuaranteed;
  }

  authorize(connection: ProviderConnectionReference, viewer: WorkspaceViewerContext): Promise<AuthorizedTransport> {
    return this.deps.authorization.authorize(connection, PAPER_ORDER_PURPOSE, viewer);
  }
}

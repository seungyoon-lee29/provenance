import type { ProviderConnectionReference } from "../../shared/contracts";
import type { ViewerContext, WorkspaceViewerContext } from "../../shared/contracts/viewer-context";
import { AuthorizedTransport } from "./authorized-transport";
import { createPinnedHttpsTransportExecutor } from "./https-executor";
import { resolveProviderHostname } from "./network-policy";
import type {
  AuthorizationCommitGuard,
  AuthorizationGrantReader,
  AuthorizationHeaderResolver,
  AuthorizationStateReader,
  HostResolver,
  ProviderConnectionAuthorization,
  ProviderRouteDefinition,
  TransportExecutor,
} from "./types";

function requireWorkspaceViewer(viewer: ViewerContext): WorkspaceViewerContext {
  if (viewer.kind !== "workspace") throw new Error("provider authorization requires a workspace viewer");
  return viewer;
}

export class ProviderAuthorization {
  readonly #routes: ReadonlyMap<string, ProviderRouteDefinition>;

  constructor(
    routes: readonly ProviderRouteDefinition[],
    private readonly grantReader: AuthorizationGrantReader,
    private readonly stateReader: AuthorizationStateReader,
    private readonly headerResolver: AuthorizationHeaderResolver,
    private readonly commitGuard: AuthorizationCommitGuard,
    private readonly hostResolver: HostResolver = resolveProviderHostname,
    private readonly executor: TransportExecutor = createPinnedHttpsTransportExecutor(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#routes = new Map(routes.map((route) => [route.id, route]));
    if (this.#routes.size !== routes.length) throw new Error("provider route registry contains a duplicate id");
    const forbiddenHeaders = new Set(["connection", "content-length", "content-type", "cookie", "forwarded", "host", "transfer-encoding"]);
    for (const route of routes) {
      const headerNames = route.allowedAuthorizationHeaders.map((name) => name.toLowerCase());
      if (route.id.length === 0 || route.maxResponseBytes < 1 || route.maxResponseBytes > 1_048_576 || route.timeoutMs < 1 || route.timeoutMs > 30_000) {
        throw new Error("provider route registry contains an invalid boundary");
      }
      if (new Set(headerNames).size !== headerNames.length || headerNames.some((name) => forbiddenHeaders.has(name) || name.startsWith("x-forwarded-") || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name))) {
        throw new Error("provider route registry contains a forbidden authorization header");
      }
    }
  }

  async authorize(connectionReference: ProviderConnectionReference, purpose: string, viewerContext: ViewerContext): Promise<AuthorizedTransport> {
    const viewer = requireWorkspaceViewer(viewerContext);
    let connection: ProviderConnectionAuthorization;
    try {
      connection = await this.grantReader(connectionReference, purpose, viewer);
    } catch {
      throw new Error("provider authorization unavailable");
    }
    if (connection.connectionReference !== connectionReference) throw new Error("provider authorization connection mismatch");
    if (purpose !== connection.purpose) throw new Error("provider authorization purpose mismatch");
    if (viewer.workspaceReference !== connection.workspaceReference) throw new Error("provider authorization workspace mismatch");
    if (connection.expiresAt.getTime() <= this.now().getTime()) throw new Error("provider authorization expired");
    if (connection.allowedRouteIds.length === 0) throw new Error("provider authorization requires an allowlisted route");
    const transport = new AuthorizedTransport(connection, viewer, this.#routes, this.stateReader, this.headerResolver, this.commitGuard, this.hostResolver, this.executor, this.now);
    await transport.assertCurrent();
    return transport;
  }
}

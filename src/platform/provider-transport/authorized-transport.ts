import type { WorkspaceViewerContext } from "../../shared/contracts/viewer-context";
import { assertPublicRoute } from "./network-policy";
import type {
  AuthorizationHeaderResolver,
  AuthorizationCommitGuard,
  AuthorizationStateReader,
  HostResolver,
  ProviderConnectionAuthorization,
  ProviderRouteDefinition,
  TransportExecutor,
} from "./types";

function sameUniqueRouteSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && leftSet.size === rightSet.size
    && [...leftSet].every((routeId) => rightSet.has(routeId));
}

export class AuthorizedResult {
  #committing = false;

  constructor(
    private readonly value: unknown,
    private readonly authorization: ProviderConnectionAuthorization,
    private readonly viewer: WorkspaceViewerContext,
    private readonly commitGuard: AuthorizationCommitGuard,
  ) {}

  async commit<Result>(persist: (value: unknown) => Promise<Result>): Promise<Result> {
    if (this.#committing) throw new Error("authorized result has already been committed");
    this.#committing = true;
    try {
      return await this.commitGuard.commitWhileCurrent(this.authorization, this.viewer, this.value, persist);
    } catch (error) {
      this.#committing = false;
      throw error;
    }
  }
}

export class AuthorizedTransport {
  constructor(
    private readonly authorization: ProviderConnectionAuthorization,
    private readonly viewer: WorkspaceViewerContext,
    private readonly routes: ReadonlyMap<string, ProviderRouteDefinition>,
    private readonly stateReader: AuthorizationStateReader,
    private readonly headerResolver: AuthorizationHeaderResolver,
    private readonly commitGuard: AuthorizationCommitGuard,
    private readonly hostResolver: HostResolver,
    private readonly executor: TransportExecutor,
    private readonly now: () => Date,
  ) {}

  async assertCurrent(): Promise<void> {
    if (this.authorization.expiresAt.getTime() <= this.now().getTime()) throw new Error("provider authorization expired");
    let current;
    try {
      current = await this.stateReader(this.authorization, this.viewer);
    } catch {
      throw new Error("provider authorization unavailable");
    }
    const stale = current.connectionState !== "verified"
      || current.purpose !== this.authorization.purpose
      || current.connectionReference !== this.authorization.connectionReference
      || current.workspaceReference !== this.authorization.workspaceReference
      || current.provider !== this.authorization.provider
      || current.environment !== this.authorization.environment
      || current.capability !== this.authorization.capability
      || !sameUniqueRouteSet(current.allowedRouteIds, this.authorization.allowedRouteIds)
      || current.credentialVersion !== this.authorization.credentialVersion
      || current.credentialGeneration !== this.authorization.credentialGeneration
      || current.lifecycleFence !== this.authorization.lifecycleFence
      || current.sessionGeneration !== this.viewer.sessionGeneration
      || current.accountAuthorizationEpoch !== this.viewer.accountAuthorizationEpoch
      || current.membershipRevision !== this.viewer.membershipRevision;
    if (stale) throw new Error("provider authorization is stale");
  }

  async execute(routeId: string, payload: unknown): Promise<AuthorizedResult> {
    if (!this.authorization.allowedRouteIds.includes(routeId)) throw new Error("provider route is not authorized");
    const route = this.routes.get(routeId);
    if (route === undefined) throw new Error("provider route is not registered");
    if (route.provider !== this.authorization.provider || route.environment !== this.authorization.environment || route.capability !== this.authorization.capability) {
      throw new Error("provider route does not match its authorization");
    }
    const requestResult = route.requestSchema.safeParse(payload);
    if (!requestResult.success) throw new Error("provider request does not match the registered schema");
    const request = requestResult.data;
    const networkTarget = await assertPublicRoute(route.origin, route.path, this.hostResolver);
    await this.assertCurrent();
    let authorizationHeaders: Readonly<Record<string, string>>;
    try {
      authorizationHeaders = await this.headerResolver(this.authorization, route);
    } catch {
      throw new Error("provider credential unavailable");
    }
    const allowedHeaderNames = new Set(route.allowedAuthorizationHeaders.map((name) => name.toLowerCase()));
    if (Object.keys(authorizationHeaders).some((name) => !allowedHeaderNames.has(name.toLowerCase()))) {
      throw new Error("credential resolver returned a forbidden authorization header");
    }
    const normalizedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(authorizationHeaders)) {
      const normalizedName = name.toLowerCase();
      if (normalizedHeaders[normalizedName] !== undefined) throw new Error("credential resolver returned a duplicate authorization header");
      if (value.length === 0 || value.length > 8_192 || /[\r\n\0]/u.test(value)) throw new Error("credential resolver returned an invalid authorization header");
      normalizedHeaders[normalizedName] = value;
    }
    await this.assertCurrent();
    let rawResponse: unknown;
    try {
      rawResponse = await this.executor({
        url: networkTarget.target,
        method: route.method,
        headers: { ...normalizedHeaders, "content-type": "application/json" },
        ...(route.method === "POST" ? { body: JSON.stringify(request) } : {}),
        redirect: "error",
        maxResponseBytes: route.maxResponseBytes,
        resolvedAddresses: networkTarget.addresses,
        timeoutMs: route.timeoutMs,
      });
    } catch {
      throw new Error("provider transport failed");
    }
    const responseResult = route.responseSchema.safeParse(rawResponse);
    if (!responseResult.success) throw new Error("provider response does not match the registered schema");
    const response = responseResult.data;
    await this.assertCurrent();
    return new AuthorizedResult(response, this.authorization, this.viewer, this.commitGuard);
  }
}

import "server-only";
import type { z } from "zod";

import type {
  AccountAuthorizationEpoch,
  ConnectionLifecycleFence,
  CredentialGeneration,
  CredentialVersion,
  MembershipRevision,
  ProviderConnectionReference,
  SessionGeneration,
  WorkspaceReference,
} from "../../shared/contracts";
import type { WorkspaceViewerContext } from "../../shared/contracts/viewer-context";
import type { ProviderEnvironment } from "../credential-vault";

export type ProviderRouteDefinition = Readonly<{
  id: string;
  provider: string;
  origin: string;
  path: string;
  method: "GET" | "POST";
  environment: ProviderEnvironment;
  capability: string;
  requestSchema: z.ZodType<unknown>;
  responseSchema: z.ZodType<unknown>;
  allowedAuthorizationHeaders: readonly string[];
  maxResponseBytes: number;
  timeoutMs: number;
}>;

export type ProviderConnectionAuthorization = Readonly<{
  purpose: string;
  connectionReference: ProviderConnectionReference;
  workspaceReference: WorkspaceReference;
  provider: string;
  environment: ProviderEnvironment;
  capability: string;
  credentialVersion: CredentialVersion;
  credentialGeneration: CredentialGeneration;
  lifecycleFence: ConnectionLifecycleFence;
  expiresAt: Date;
  allowedRouteIds: readonly string[];
}>;

export type CurrentAuthorizationState = Readonly<{
  purpose: string;
  connectionReference: ProviderConnectionReference;
  workspaceReference: WorkspaceReference;
  provider: string;
  environment: ProviderEnvironment;
  capability: string;
  allowedRouteIds: readonly string[];
  connectionState: "verified" | "revoked" | "disabled";
  credentialVersion: CredentialVersion;
  credentialGeneration: CredentialGeneration;
  lifecycleFence: ConnectionLifecycleFence;
  sessionGeneration: SessionGeneration;
  accountAuthorizationEpoch: AccountAuthorizationEpoch;
  membershipRevision: MembershipRevision;
}>;

export type TransportExecutorRequest = Readonly<{
  url: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: string;
  redirect: "error";
  maxResponseBytes: number;
  resolvedAddresses: readonly string[];
  timeoutMs: number;
}>;

export type TransportExecutor = (request: TransportExecutorRequest) => Promise<unknown>;
export type AuthorizationHeaderResolver = (authorization: ProviderConnectionAuthorization, route: ProviderRouteDefinition) => Promise<Readonly<Record<string, string>>>;
export type AuthorizationGrantReader = (connection: ProviderConnectionReference, purpose: string, viewer: WorkspaceViewerContext) => Promise<ProviderConnectionAuthorization>;
export type AuthorizationStateReader = (authorization: ProviderConnectionAuthorization, viewer: WorkspaceViewerContext) => Promise<CurrentAuthorizationState>;
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface AuthorizationCommitGuard {
  commitWhileCurrent<Result>(
    authorization: ProviderConnectionAuthorization,
    viewer: WorkspaceViewerContext,
    value: unknown,
    persist: (value: unknown) => Promise<Result>,
  ): Promise<Result>;
}

import type {
  AccountAuthorizationEpoch,
  AccountReference,
  MembershipRevision,
  SessionGeneration,
  SessionReference,
  WorkspaceReference,
} from "./brands";

export type GuestViewerContext = Readonly<{
  kind: "guest";
  requestId: string;
}>;

export type WorkspaceViewerContext = Readonly<{
  kind: "workspace";
  requestId: string;
  workspaceReference: WorkspaceReference;
  accountReference: AccountReference;
  sessionReference: SessionReference;
  sessionGeneration: SessionGeneration;
  accountAuthorizationEpoch: AccountAuthorizationEpoch;
  membershipRevision: MembershipRevision;
}>;

export type ViewerContext = GuestViewerContext | WorkspaceViewerContext;

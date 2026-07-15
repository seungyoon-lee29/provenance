import { brandReference } from "../../../shared/contracts/brands";
import type { CredentialVault, CredentialAadContext, CredentialEnvelope } from "../../../platform/credential-vault";
import type {
  ConnectionLifecycleFence,
  CredentialGeneration,
  CredentialVersion,
  ProviderConnectionReference,
  Revision,
} from "../../../shared/contracts/brands";
import type { MutationControl } from "../../../shared/contracts/mutation-control";
import type { ViewerContext, WorkspaceViewerContext } from "../../../shared/contracts/viewer-context";
import type { ProviderConnections } from "../../../shared/contracts/module-interfaces";
import type {
  ProviderConnectionMaskedView,
  ProviderConnectionReceipt,
  RevokeProviderConnectionCommand,
  SaveProviderConnectionCommand,
  VerificationState,
  VerifyProviderConnectionCommand,
} from "./contracts";

type StoredConnection = {
  reference: ProviderConnectionReference;
  workspaceReference: WorkspaceViewerContext["workspaceReference"];
  provider: string;
  environment: SaveProviderConnectionCommand["environment"];
  capability: string;
  credentialType: string;
  generation: number;
  fence: number;
  revision: number;
  verification: VerificationState;
  maskedHint: string;
  // Sealed secret, dropped (undefined) after revoke so no path can read it.
  envelope: CredentialEnvelope | undefined;
  // idempotencyKey -> canonical payload hash of the receipt-producing command.
  receipts: Map<string, string>;
};

export type ProviderConnectionsCoreDeps = Readonly<{
  vault: CredentialVault;
  now: () => number;
  newConnectionReference: (seed: string) => ProviderConnectionReference;
}>;

export interface ProviderConnectionsCore extends ProviderConnections {
  // Narrow the interface's ProviderConnectionOutcome brand to the concrete receipt union.
  list(viewer: ViewerContext): Promise<ProviderConnectionMaskedView[]>;
  save(command: SaveProviderConnectionCommand, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionReceipt>;
  verify(command: VerifyProviderConnectionCommand, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionReceipt>;
  revoke(command: RevokeProviderConnectionCommand, control: MutationControl, viewer: ViewerContext): Promise<ProviderConnectionReceipt>;
  authorizeSnapshot(reference: ProviderConnectionReference, generation: CredentialGeneration, viewer: ViewerContext): boolean;
  // Test/inspection seam: the raw sealed envelope, if any. Never crosses a network boundary.
  debugSealedEnvelope(reference: ProviderConnectionReference): CredentialEnvelope | undefined;
}

function requireWorkspace(viewer: ViewerContext): WorkspaceViewerContext | undefined {
  return viewer.kind === "workspace" ? viewer : undefined;
}

function generation(value: number): CredentialGeneration {
  return brandReference<string, "CredentialGeneration">(String(value)) as CredentialGeneration;
}
function credentialVersion(value: number): CredentialVersion {
  return brandReference<string, "CredentialVersion">(String(value)) as CredentialVersion;
}
function lifecycleFence(value: number): ConnectionLifecycleFence {
  return brandReference<string, "ConnectionLifecycleFence">(String(value)) as ConnectionLifecycleFence;
}
function revision(value: number): Revision {
  return brandReference<string, "Revision">(String(value)) as Revision;
}

function maskedHint(secret: string): string {
  return secret.length >= 4 ? secret.slice(-4) : "".padStart(secret.length, "*");
}

function aad(connection: StoredConnection): CredentialAadContext {
  return {
    purpose: "provider_credential",
    workspaceReference: connection.workspaceReference,
    providerConnectionReference: connection.reference,
    provider: connection.provider,
    credentialType: connection.credentialType,
    environment: connection.environment,
  };
}

function view(connection: StoredConnection): ProviderConnectionMaskedView {
  return {
    kind: "ProviderConnectionView",
    connectionReference: connection.reference,
    provider: connection.provider,
    environment: connection.environment,
    capability: connection.capability,
    credentialType: connection.credentialType,
    credentialGeneration: generation(connection.generation),
    credentialVersion: credentialVersion(connection.generation),
    lifecycleFence: lifecycleFence(connection.fence),
    revision: revision(connection.revision),
    verification: connection.verification,
    maskedHint: connection.maskedHint,
  };
}

// Canonical payload for idempotency: the meaningful command shape, secret included
// by its masked identity so a different secret is a different payload without
// hashing plaintext into the receipt table.
function canonicalSavePayload(command: SaveProviderConnectionCommand): string {
  return JSON.stringify([
    "save",
    command.provider,
    command.environment,
    command.capability,
    command.credentialType,
    maskedHint(command.secret),
    command.secret.length,
  ]);
}
function canonicalVerifyPayload(command: VerifyProviderConnectionCommand): string {
  return JSON.stringify(["verify", command.result]);
}
function canonicalRevokePayload(): string {
  return JSON.stringify(["revoke"]);
}

export function createProviderConnectionsCore(deps: ProviderConnectionsCoreDeps): ProviderConnectionsCore {
  const byReference = new Map<string, StoredConnection>();
  // Create-idempotency: (workspace, idempotencyKey) -> the connection that key created,
  // plus the canonical payload it created it with (for same-key/different-payload conflict).
  const createReceipts = new Map<string, { reference: ProviderConnectionReference; payload: string }>();

  function owned(reference: ProviderConnectionReference, viewer: WorkspaceViewerContext): StoredConnection | undefined {
    const connection = byReference.get(reference);
    // Cross-workspace isolation: a connection in another workspace is invisible.
    if (connection === undefined || connection.workspaceReference !== viewer.workspaceReference) return undefined;
    return connection;
  }

  // Returns a receipt if this (connection, key) already produced one; enforces
  // same-key/different-payload conflict. Undefined means "proceed to mutate".
  function replay(
    connection: StoredConnection,
    control: MutationControl,
    payload: string,
    disposition: "accepted" | "conflict",
  ): ProviderConnectionReceipt | undefined {
    const seen = connection.receipts.get(control.idempotencyKey);
    if (seen === undefined) return undefined;
    if (seen === payload) {
      return disposition === "accepted"
        ? { kind: "ProviderConnectionOutcome", disposition: "accepted", view: view(connection), submissionUncertainty: false }
        : { kind: "ProviderConnectionOutcome", disposition: "conflict", view: view(connection) };
    }
    return { kind: "ProviderConnectionOutcome", disposition: "conflict", view: view(connection) };
  }

  function staleRevision(connection: StoredConnection, control: MutationControl): boolean {
    return String(connection.revision) !== String(control.expectedRevision);
  }

  return {
    async list(viewer: ViewerContext): Promise<ProviderConnectionMaskedView[]> {
      const workspace = requireWorkspace(viewer);
      if (workspace === undefined) return [];
      return [...byReference.values()]
        .filter((connection) => connection.workspaceReference === workspace.workspaceReference)
        .map(view);
    },

    async save(
      command: SaveProviderConnectionCommand,
      control: MutationControl,
      viewer: ViewerContext,
    ): Promise<ProviderConnectionReceipt> {
      const workspace = requireWorkspace(viewer);
      if (workspace === undefined) {
        // SEC-01: guest/no-workspace viewers never seal a secret or touch the store.
        return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "unauthorized" };
      }
      const payload = canonicalSavePayload(command);

      if (command.connectionReference === null) {
        // Create. Idempotency is keyed by (workspace, idempotencyKey) since a fresh
        // create has no prior connection/revision to key against.
        const createKey = `${workspace.workspaceReference} ${control.idempotencyKey}`;
        const prior = createReceipts.get(createKey);
        if (prior !== undefined) {
          const existing = byReference.get(prior.reference);
          if (existing !== undefined) {
            return prior.payload === payload
              ? { kind: "ProviderConnectionOutcome", disposition: "accepted", view: view(existing), submissionUncertainty: false }
              : { kind: "ProviderConnectionOutcome", disposition: "conflict", view: view(existing) };
          }
        }
        const reference = deps.newConnectionReference(control.idempotencyKey);
        const connection: StoredConnection = {
          reference,
          workspaceReference: workspace.workspaceReference,
          provider: command.provider,
          environment: command.environment,
          capability: command.capability,
          credentialType: command.credentialType,
          generation: 1,
          fence: 1,
          revision: 1,
          verification: "unverified",
          maskedHint: maskedHint(command.secret),
          envelope: undefined,
          receipts: new Map(),
        };
        connection.envelope = deps.vault.seal(Buffer.from(command.secret, "utf8"), aad(connection));
        byReference.set(reference, connection);
        createReceipts.set(createKey, { reference, payload });
        return { kind: "ProviderConnectionOutcome", disposition: "accepted", view: view(connection), submissionUncertainty: false };
      }

      // Rotate an existing connection.
      const connection = owned(command.connectionReference, workspace);
      if (connection === undefined) return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "not_found" };
      const replayed = replay(connection, control, payload, "accepted");
      if (replayed !== undefined) return replayed;
      if (staleRevision(connection, control)) {
        return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "stale_revision", currentRevision: revision(connection.revision) };
      }
      connection.generation += 1;
      connection.revision += 1;
      connection.maskedHint = maskedHint(command.secret);
      connection.verification = "unverified";
      connection.envelope = deps.vault.seal(Buffer.from(command.secret, "utf8"), aad(connection));
      connection.receipts.set(control.idempotencyKey, payload);
      return { kind: "ProviderConnectionOutcome", disposition: "accepted", view: view(connection), submissionUncertainty: false };
    },

    async verify(
      command: VerifyProviderConnectionCommand,
      control: MutationControl,
      viewer: ViewerContext,
    ): Promise<ProviderConnectionReceipt> {
      const workspace = requireWorkspace(viewer);
      if (workspace === undefined) return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "unauthorized" };
      const connection = owned(command.connectionReference, workspace);
      if (connection === undefined) return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "not_found" };
      const payload = canonicalVerifyPayload(command);
      const replayed = replay(connection, control, payload, "accepted");
      if (replayed !== undefined) return replayed;
      if (staleRevision(connection, control)) {
        return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "stale_revision", currentRevision: revision(connection.revision) };
      }
      connection.revision += 1;
      connection.verification = command.result;
      connection.receipts.set(control.idempotencyKey, payload);
      return { kind: "ProviderConnectionOutcome", disposition: "accepted", view: view(connection), submissionUncertainty: false };
    },

    async revoke(
      command: RevokeProviderConnectionCommand,
      control: MutationControl,
      viewer: ViewerContext,
    ): Promise<ProviderConnectionReceipt> {
      const workspace = requireWorkspace(viewer);
      if (workspace === undefined) return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "unauthorized" };
      const connection = owned(command.connectionReference, workspace);
      if (connection === undefined) return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "not_found" };
      const payload = canonicalRevokePayload();
      const replayed = replay(connection, control, payload, "accepted");
      if (replayed !== undefined) return replayed;
      if (staleRevision(connection, control)) {
        return { kind: "ProviderConnectionOutcome", disposition: "rejected", reason: "stale_revision", currentRevision: revision(connection.revision) };
      }
      // SEC-10 generation-first: advance the generation + lifecycle fence BEFORE
      // dropping the sealed secret, so no in-flight authorize can bind the old gen.
      connection.generation += 1;
      connection.fence += 1;
      connection.revision += 1;
      connection.verification = "revoked";
      connection.envelope = undefined;
      connection.receipts.set(control.idempotencyKey, payload);
      // ponytail: submissionUncertainty is a flag; broker reconciliation is F8/F9.
      return { kind: "ProviderConnectionOutcome", disposition: "accepted", view: view(connection), submissionUncertainty: true };
    },

    authorizeSnapshot(reference, gen, viewer): boolean {
      const workspace = requireWorkspace(viewer);
      if (workspace === undefined) return false;
      const connection = owned(reference, workspace);
      if (connection === undefined || connection.envelope === undefined) return false;
      // Only the connection's current generation with a live sealed secret authorizes.
      if (String(connection.generation) !== String(gen)) return false;
      if (connection.verification === "revoked") return false;
      // Prove the secret is actually openable (a real authorize would build a transport from it).
      deps.vault.open(connection.envelope, aad(connection));
      return true;
    },

    debugSealedEnvelope(reference): CredentialEnvelope | undefined {
      return byReference.get(reference)?.envelope;
    },
  };
}

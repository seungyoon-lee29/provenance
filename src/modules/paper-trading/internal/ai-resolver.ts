import { brandReference } from "../../../shared/contracts/brands";
import type { AiMaterialReference, InternalPaperAccountReference } from "../../../shared/contracts/brands";
import type { ViewerContext, WorkspaceViewerContext } from "../../../shared/contracts/viewer-context";

import { FencedKeyedStore } from "../../notification-center/fenced-store";
import type { Erasable } from "../../notification-center/fenced-store";
import type { AiMaterialOutcome, AiMaterialResolver } from "../../research-assistant/contracts";
import type { PaperJournal } from "./journal";

/**
 * F8 Paper-owned AI material resolver (§5.4/§6.1, SEC-06).
 *
 * PaperTrading issues opaque AI Material References for its own order
 * context; ResearchAssistant never receives raw order payloads. `resolve` is
 * purpose-bound to research, re-checks workspace ownership and the CURRENT
 * auth epoch immediately before returning, and hands back a minimized,
 * redacted envelope — public order surface only, never intent references,
 * idempotency keys or anything execution-internal. Every failure path is the
 * same value-less license_restricted outcome (enumeration-safe), and the
 * store sits on the fenced substrate so administrative erasure removes the
 * references and suppresses regeneration.
 */

type MaterialRecord = Readonly<{
  reference: AiMaterialReference;
  workspace: string;
  account: InternalPaperAccountReference;
}>;

export type PaperMaterialIssueOutcome =
  | Readonly<{ status: "issued"; reference: AiMaterialReference }>
  | Readonly<{ status: "denied" }>;

const POLICY_VERSION = "paper-ai-v1";

export class PaperAiMaterialResolver implements AiMaterialResolver {
  readonly #materials = new FencedKeyedStore<MaterialRecord>();
  #counter = 0;

  constructor(
    private readonly deps: Readonly<{
      journal: PaperJournal;
      identity: Readonly<{ currentAuthorizationEpoch(viewer: ViewerContext): string }>;
      redactionPolicyVersion: string;
    }>,
  ) {}

  get erasable(): Erasable {
    return this.#materials;
  }

  issue(request: Readonly<{ account: InternalPaperAccountReference }>, viewer: ViewerContext): PaperMaterialIssueOutcome {
    if (!this.#authorized(viewer)) return { status: "denied" };
    const workspace = String(viewer.workspaceReference);
    if (this.deps.journal.ownerOf(request.account) !== workspace) return { status: "denied" };
    this.#counter += 1;
    const reference = brandReference<string, "AiMaterialReference">(`paper-material:${workspace}:${this.#counter}`);
    const written = this.#materials.write(workspace, String(reference), { reference, workspace, account: request.account }, 1);
    if (!written) return { status: "denied" };
    return { status: "issued", reference };
  }

  resolve(reference: AiMaterialReference, purpose: string, viewer: ViewerContext): Promise<AiMaterialOutcome> {
    if (purpose !== "research") return Promise.resolve(this.#restricted(purpose));
    if (!this.#authorized(viewer)) return Promise.resolve(this.#restricted(purpose));
    const workspace = String(viewer.workspaceReference);
    const record = this.#materials.get(workspace, String(reference));
    if (record === undefined) return Promise.resolve(this.#restricted(purpose));

    const state = this.deps.journal.state(workspace, record.account);
    const lines: string[] = ["Paper Trading order context (simulated; not real executions)."];
    for (const order of state.orders.values()) {
      lines.push(
        `${order.payload.side} ${order.payload.quantity} ${String(order.payload.instrument)} `
        + `${order.payload.orderType}${order.payload.limitPrice === undefined ? "" : ` @ ${order.payload.limitPrice.amount} ${order.payload.limitPrice.currency}`}`
        + ` — submission ${order.submission}, execution ${order.execution}, cancellation ${order.cancellation}, filled ${order.filledQuantity}`,
      );
    }
    const evidenceReferences = [...state.orders.values()]
      .flatMap((order) => order.fills.map((fill) => brandReference<string, "EvidenceReference">(fill.evidenceReference)));

    return Promise.resolve({
      status: "available",
      value: {
        reference: record.reference,
        category: "order",
        summary: lines.join("\n"),
        evidenceReferences,
        rights: { retention: "session", externalProcessing: true, derivative: true },
        licenseScope: {
          audience: "personal",
          purposes: ["research"],
          validUntil: "2100-01-01T00:00:00.000Z",
        },
        redactionPolicyVersion: brandReference<string, "PolicyVersion">(this.deps.redactionPolicyVersion),
      },
    });
  }

  /** Enumeration-safe single failure shape: no value, no existence signal. */
  #restricted(purpose: string): AiMaterialOutcome {
    return {
      status: "unavailable",
      reason: "license_restricted",
      source: "paper-trading",
      purpose,
      policyVersion: brandReference<string, "PolicyVersion">(POLICY_VERSION),
    };
  }

  #authorized(viewer: ViewerContext): viewer is WorkspaceViewerContext {
    if (viewer.kind !== "workspace") return false;
    return this.deps.identity.currentAuthorizationEpoch(viewer) === String(viewer.accountAuthorizationEpoch);
  }
}

import { z } from "zod";

import { brandReference } from "../contracts/brands";
import type { JobAuthorizationVersion, JobContextReference } from "../contracts";

const jobEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobReference: z.string().trim().min(1).max(200),
  purpose: z.enum(["financial_refresh", "portfolio_sync", "paper_reconcile", "notification_dispatch"]),
  authorizationVersion: z.string().trim().min(1).max(100),
});

export type JobPurpose = z.infer<typeof jobEnvelopeSchema>["purpose"];

export type JobEnvelope = Readonly<{
  schemaVersion: 1;
  jobReference: JobContextReference;
  purpose: JobPurpose;
  authorizationVersion: JobAuthorizationVersion;
}>;

export function serializeJobEnvelope(envelope: JobEnvelope): string {
  return JSON.stringify(jobEnvelopeSchema.parse(envelope));
}

export function parseJobEnvelope(serialized: string): JobEnvelope {
  if (Buffer.byteLength(serialized, "utf8") > 4_096) throw new Error("queue envelope exceeds the maximum size");
  const parsed: unknown = JSON.parse(serialized);
  const envelope = jobEnvelopeSchema.parse(parsed);
  return {
    ...envelope,
    jobReference: brandReference<string, "JobContextReference">(envelope.jobReference),
    authorizationVersion: brandReference<string, "JobAuthorizationVersion">(envelope.authorizationVersion),
  };
}

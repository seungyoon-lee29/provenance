import type { Revision } from "./brands";

export type MutationControl = Readonly<{
  idempotencyKey: string;
  expectedRevision: Revision;
}>;

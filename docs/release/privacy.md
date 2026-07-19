# Privacy and data protection

## Credentials

User provider credentials live only in server environment variables or an
AES-256-GCM encrypted vault ([ADR 0002](../adr/0002-encrypt-provider-credentials.md)).
Plaintext credentials are never stored, logged, or serialized to the browser;
connection views expose a masked last-4 hint only. Revoke is generation-first:
the credential generation and authorization fence advance before the secret and
transport are discarded, so an already-dispatched call becomes Submission
Uncertainty rather than a leak.

## Personal data boundaries

Evidence, AI material, portfolio and alert data are reached only through
purpose-bound, source-owned resolvers ([ADR 0003](../adr/0003-isolate-evidence-and-provider-credentials.md)).
Raw provider payloads and cross-purpose results are not exposed. Federated
sign-in never persists raw authorization responses, access/id tokens, or codes.

## Administrative erasure (SEC-09)

Erasure is an Identity-owned public command routed through a monotonic deletion
fence and a durable coordinator. Every source module registers a receipt; each
durable store is fence-first, so a late worker result, webhook, provider
response, or **backup restore** cannot re-create personal data after erasure.
This spans notification delivery state, personalized caches, portfolio journals,
and the read-only broker-sync stores (events, snapshots, cursors, quarantine).

## Retention

- Notification Records: 365 days
- Delivery Facts / webhook audit: 90 days
- Encrypted raw webhook bodies: 30 days
- A shorter License Scope always wins.

Account/workspace deletion includes the dispatch fence, processor erasure
intent, and backup-restore suppression. Restore drills are in
[backup.md](./backup.md).

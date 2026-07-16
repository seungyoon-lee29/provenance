import { describe, expect, it } from "vitest";

import {
  UNSUBSCRIBE_INGRESS,
  UnsubscribeFloodLimiter,
  UnsubscribeInvalidAudit,
  UnsubscribeTokenStore,
  checkUnsubscribeIngress,
  handleUnsubscribe,
  parseUrlencodedFields,
} from "../src/modules/notification-center/unsubscribe";

const LINEAGE = {
  workspace: "workspace:w1",
  endpoint: "endpoint:e1",
  topic: "topic:rule-1",
  channel: "email",
  consentRevision: 3,
} as const;

const ONE_CLICK = [{ name: "List-Unsubscribe", value: "One-Click", kind: "text" }] as const;

function issued() {
  const store = new UnsubscribeTokenStore();
  const token = store.issue(LINEAGE, 1_000, 1);
  if (token === undefined) throw new Error("expected a token from a non-erased workspace");
  return { store, token };
}

describe("unsubscribe token — hash-only, lineage-bound, ≥256-bit (spec §12:342)", () => {
  it("issues a token of at least 256 bits and stores only its hash", () => {
    const { store, token } = issued();
    // base64url of ≥32 random bytes.
    expect(Buffer.from(token, "base64url").byteLength).toBeGreaterThanOrEqual(32);
    const persisted = JSON.stringify(store.entries("workspace:w1"));
    expect(persisted).not.toContain(token);
    expect(persisted).toContain("endpoint:e1");
  });

  it("issues unpredictable tokens (two issues never collide)", () => {
    const store = new UnsubscribeTokenStore();
    expect(store.issue(LINEAGE, 1_000, 1)).not.toBe(store.issue(LINEAGE, 1_000, 1));
  });

  it("a valid one-click POST revokes exactly the issued lineage, idempotently", () => {
    const { store, token } = issued();
    const request = { method: "POST", token, fields: ONE_CLICK };
    const first = handleUnsubscribe(request, store, 2_000);
    expect(first).toEqual({ status: "unsubscribed", lineage: LINEAGE });
    // a replayed one-click POST is idempotent — same outcome, one revocation.
    expect(handleUnsubscribe(request, store, 3_000)).toEqual({ status: "unsubscribed", lineage: LINEAGE });
    expect(store.entries("workspace:w1").filter((e) => e.consumedAtMs !== undefined)).toHaveLength(1);
  });

  it("GET renders confirmation and never consumes the token", () => {
    const { store, token } = issued();
    expect(handleUnsubscribe({ method: "GET", token, fields: [] }, store, 2_000)).toEqual({ status: "render_confirmation" });
    expect(store.entries("workspace:w1").every((e) => e.consumedAtMs === undefined)).toBe(true);
    // the token still consumes normally afterwards.
    expect(handleUnsubscribe({ method: "POST", token, fields: ONE_CLICK }, store, 3_000).status).toBe("unsubscribed");
  });

  it("rejects any POST that is not exactly one List-Unsubscribe=One-Click text field", () => {
    const { store, token } = issued();
    const cases = [
      [],
      [{ name: "List-Unsubscribe", value: "One-Click", kind: "file" }],
      [{ name: "List-Unsubscribe", value: "Two-Click", kind: "text" }],
      [...ONE_CLICK, { name: "extra", value: "1", kind: "text" }],
      [...ONE_CLICK, ...ONE_CLICK],
    ] as const;
    for (const fields of cases) {
      expect(handleUnsubscribe({ method: "POST", token, fields: [...fields] }, store, 2_000)).toEqual({
        status: "invalid",
        reason: "malformed_one_click",
      });
    }
    expect(store.entries("workspace:w1").every((e) => e.consumedAtMs === undefined)).toBe(true);
  });

  it("rejects an unknown token without revealing anything else", () => {
    const { store } = issued();
    expect(handleUnsubscribe({ method: "POST", token: "AAAA", fields: [...ONE_CLICK] }, store, 2_000)).toEqual({
      status: "invalid",
      reason: "unknown_token",
    });
  });

  it("erasure shreds token hashes and suppresses re-issue at an old epoch", () => {
    const { store, token } = issued();
    expect(store.eraseSubject("workspace:w1", 5)).toBe(1);
    expect(handleUnsubscribe({ method: "POST", token, fields: [...ONE_CLICK] }, store, 2_000)).toEqual({
      status: "invalid",
      reason: "unknown_token",
    });
    // backup restore / late worker at an old epoch cannot re-materialize a token.
    expect(store.issue(LINEAGE, 6_000, 3)).toBeUndefined();
  });

  it("parses an urlencoded one-click body into text fields", () => {
    expect(parseUrlencodedFields("List-Unsubscribe=One-Click")).toEqual([
      { name: "List-Unsubscribe", value: "One-Click", kind: "text" },
    ]);
  });
});

describe("unsubscribe ingress — limits before buffering (spec §12:345)", () => {
  const ok = { urlBytes: 512, bodyBytes: 64, headerCount: 8, headerBytes: 1_024 };

  it("admits a conforming request and enforces URL 4 KiB / body 8 KiB / 64 headers / 16 KiB", () => {
    expect(checkUnsubscribeIngress(ok)).toEqual({ allowed: true });
    expect(checkUnsubscribeIngress({ ...ok, urlBytes: 4 * 1024 + 1 })).toEqual({ allowed: false, reason: "url_too_large" });
    expect(checkUnsubscribeIngress({ ...ok, bodyBytes: 8 * 1024 + 1 })).toEqual({ allowed: false, reason: "body_too_large" });
    expect(checkUnsubscribeIngress({ ...ok, headerCount: 65 })).toEqual({ allowed: false, reason: "too_many_headers" });
    expect(checkUnsubscribeIngress({ ...ok, headerBytes: 16 * 1024 + 1 })).toEqual({ allowed: false, reason: "headers_too_large" });
    expect(UNSUBSCRIBE_INGRESS.deadlineMs).toBe(2_000);
  });

  it("limits an IP prefix to 10/minute", () => {
    const limiter = new UnsubscribeFloodLimiter();
    for (let i = 0; i < 10; i += 1) expect(limiter.admit("ip:1.2.3", i * 1_000)).toBe("admitted");
    expect(limiter.admit("ip:1.2.3", 10_000)).toBe("ip_minute_limited");
    // the next minute window admits again.
    expect(limiter.admit("ip:1.2.3", 61_000)).toBe("admitted");
  });

  it("limits an IP prefix to 100/day even across minutes", () => {
    const limiter = new UnsubscribeFloodLimiter();
    let admitted = 0;
    for (let i = 0; i < 120; i += 1) {
      // spread over minutes so the per-minute limit does not bind.
      if (limiter.admit("ip:1.2.3", i * 60_000) === "admitted") admitted += 1;
    }
    expect(admitted).toBe(100);
    expect(limiter.admit("ip:1.2.3", 121 * 60_000)).toBe("ip_day_limited");
  });

  it("limits globally to 50/second across prefixes", () => {
    const limiter = new UnsubscribeFloodLimiter();
    const results = Array.from({ length: 60 }, (_, i) => limiter.admit(`ip:${i}`, 500));
    expect(results.filter((r) => r === "admitted")).toHaveLength(50);
    expect(results.filter((r) => r === "global_limited")).toHaveLength(10);
  });
});

describe("unsubscribe invalid audit — no token-derived keys, bounded rows (spec §12:345)", () => {
  it("keys counters by route+reason+minute+edgeRegion only and samples at most 20/hour", () => {
    const audit = new UnsubscribeInvalidAudit(["one_click"], ["unknown_token", "malformed_one_click"], ["icn"]);
    const results = Array.from({ length: 25 }, () => audit.record("one_click", "unknown_token", "icn", 30_000));
    expect(results.filter((r) => r.sampled)).toHaveLength(20);
    // every invalid still counts even when not sampled.
    expect(results.every((r) => r.counted)).toBe(true);
    const rows = audit.rows();
    expect(rows).toEqual([{ key: "one_click|unknown_token|0|icn", count: 25 }]);
  });

  it("refuses new counter rows beyond the 24h cap of routes×reasons×regions×1440+480", () => {
    const audit = new UnsubscribeInvalidAudit(["one_click"], ["unknown_token"], ["icn"]);
    expect(audit.rowCap).toBe(1 * 1 * 1 * 1_440 + 480);
    for (let minute = 0; minute < audit.rowCap; minute += 1) {
      expect(audit.record("one_click", "unknown_token", "icn", minute * 60_000).counted).toBe(true);
    }
    expect(audit.record("one_click", "unknown_token", "icn", audit.rowCap * 60_000).counted).toBe(false);
    // an existing row still increments even at the cap.
    expect(audit.record("one_click", "unknown_token", "icn", 0).counted).toBe(true);
    // the retention sweep frees rows older than 24h, after which new rows count again.
    audit.prune(audit.rowCap * 60_000);
    expect(audit.record("one_click", "unknown_token", "icn", audit.rowCap * 60_000).counted).toBe(true);
  });
});

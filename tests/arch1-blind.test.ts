/**
 * ARCH-1 BLIND gate — PaperTradingService.readAccount, the projection it hands
 * back, the CLI composition's workspace admission and the `paper.account`
 * operation surface.
 *
 * Written WITHOUT reading src/modules/paper-trading/internal/service.ts,
 * src/modules/paper-trading/internal/journal.ts, src/operations/catalog.ts,
 * src/cli/commands.ts or src/composition/paper-assembly.ts. Only the handed
 * contracts + behavioral SPEC, src/modules/paper-trading/internal/contracts.ts,
 * src/modules/paper-trading/internal/journal-store.pg.ts (for the snapshot row
 * shapes SPEC 9/10 forge), src/shared/** types and the EXISTING test harnesses
 * (tests/f8-paper-trading.test.ts, tests/f8-journal-boundary.test.ts,
 * tests/persistence/paper-journal-contract.ts,
 * tests/persistence/paper-cli.pg.test.ts — construction patterns only) were
 * consulted. Signatures of the five sealed modules were recovered from the type
 * checker (exported symbol types only), never from their source.
 *
 * SPEC 8/9/10 were added in a second blind pass, against the same seal.
 *
 * No case here needs postgres — see the note above the surface section for why
 * the durable block was dropped rather than made to race, and the report note
 * on `paper open`'s `created` flag, which has NO pg-free seam at all.
 */
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { brandReference } from "../src/shared/contracts/brands";
import type { ViewerContext, WorkspaceViewerContext } from "../src/shared/contracts/viewer-context";
import type {
  PaperCashRow,
  PaperFill,
  PaperInstrumentReference,
  PaperOrderPayload,
} from "../src/modules/paper-trading/internal/contracts";
import { MemoryPaperJournalStore } from "../src/modules/paper-trading/internal/journal";
import type {
  PaperCommandAppend,
  PaperJournalSnapshot,
  PaperJournalStore,
  PaperSystemAppend,
} from "../src/modules/paper-trading/internal/journal";
import { PaperTradingService } from "../src/modules/paper-trading/internal/service";
import { paperAccountCommand } from "../src/cli/commands";
import { CLI_WORKSPACE, cliViewer, createDurablePaperTrading } from "../src/composition/paper-assembly";
import { operationCatalog } from "../src/operations/catalog";

// ---------------------------------------------------------------------------
// harness (inline; nothing production-side is imported to PRODUCE an expected)
// ---------------------------------------------------------------------------

const NOW = "2026-07-26T02:00:00.000Z";
const LATER = "2026-07-26T02:05:00.000Z";
const WS_A = "workspace:a";
const SEED_USD = [{ amount: 100_000, currency: "USD" }] as const;

function viewer(overrides?: Partial<WorkspaceViewerContext>): WorkspaceViewerContext {
  return {
    kind: "workspace",
    requestId: "req-arch1",
    workspaceReference: brandReference<string, "WorkspaceReference">(WS_A),
    accountReference: brandReference<string, "AccountReference">("account:a"),
    sessionReference: brandReference<string, "SessionReference">("session:a"),
    sessionGeneration: brandReference<string, "SessionGeneration">("gen:1"),
    accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:1"),
    membershipRevision: brandReference<string, "MembershipRevision">("mem:1"),
    ...overrides,
  };
}

/** A second, fully authorized tenant — same identity epoch, different workspace. */
function otherWorkspaceViewer(): WorkspaceViewerContext {
  return viewer({
    requestId: "req-arch1-b",
    workspaceReference: brandReference<string, "WorkspaceReference">("workspace:b"),
    accountReference: brandReference<string, "AccountReference">("account:b"),
    sessionReference: brandReference<string, "SessionReference">("session:b"),
  });
}

const GUEST: ViewerContext = { kind: "guest", requestId: "req-guest" };

const INSTRUMENT = brandReference<string, "PaperInstrumentReference">("instr:ARCH1") as PaperInstrumentReference;

function limitBuy(quantity: number, limit: number): PaperOrderPayload {
  return {
    instrument: INSTRUMENT,
    venue: "XNAS",
    session: "regular",
    side: "buy",
    orderType: "limit",
    limitPrice: { amount: limit, currency: "USD" },
    quantity,
    timeInForce: "GTC",
  };
}

function makeService(options?: {
  store?: PaperJournalStore;
  seedCash?: readonly { amount: number; currency: string }[];
  currentEpoch?: () => string;
}): PaperTradingService {
  let updateCounter = 0;
  return new PaperTradingService({
    now: () => NOW,
    identity: { currentAuthorizationEpoch: options?.currentEpoch ?? (() => "epoch:1") },
    observations: { currentObservation: () => undefined },
    policy: {
      policyVersion: "simulation-v1",
      seedCash: options?.seedCash ?? SEED_USD,
      intentTtlMs: 10 * 60 * 1000,
      maxSlippageBps: 25,
    },
    updateId: () => `update:${(updateCounter += 1)}`,
    journalStore: options?.store ?? new MemoryPaperJournalStore(),
  });
}

/** Counts every WRITE that reaches durability — the probe for "a read writes nothing". */
class CountingStore implements PaperJournalStore {
  readonly #inner = new MemoryPaperJournalStore();
  writes = 0;

  appendCommand(append: PaperCommandAppend) {
    this.writes += 1;
    return this.#inner.appendCommand(append);
  }

  appendSystem(append: PaperSystemAppend) {
    this.writes += 1;
    return this.#inner.appendSystem(append);
  }

  eraseWorkspace(workspace: string, fence: number, _tx?: Parameters<PaperJournalStore["eraseWorkspace"]>[2]) {
    this.writes += 1;
    // ponytail: the in-memory oracle has no transactions, so `tx` is dropped.
    return this.#inner.eraseWorkspace(workspace, fence);
  }

  load() {
    return this.#inner.load();
  }
}

/** Every durability call fails — a broken database, not an empty one. */
function failingStore(message: string): PaperJournalStore {
  const boom = () => Promise.reject(new Error(message));
  return { appendCommand: boom, appendSystem: boom, eraseWorkspace: boom, load: boom };
}

/** Wraps a store, transforming only what HYDRATION sees. Writes pass through. */
function storeWithSnapshot(
  inner: PaperJournalStore,
  transform: (snapshot: PaperJournalSnapshot) => PaperJournalSnapshot,
): PaperJournalStore {
  return {
    appendCommand: (append) => inner.appendCommand(append),
    appendSystem: (append) => inner.appendSystem(append),
    eraseWorkspace: (workspace, fence) => inner.eraseWorkspace(workspace, fence),
    load: async () => transform(await inner.load()),
  };
}

/**
 * pg hydration semantics: rows come back as PLAIN, mutable objects rebuilt from
 * JSONB. The in-memory store instead hands back the very objects it froze at
 * append time, so a projection that leaks live ledger objects is INVISIBLE
 * without this round trip — the reason SPEC 9 is tested through a new service.
 */
const rehydrated = (snapshot: PaperJournalSnapshot): PaperJournalSnapshot =>
  JSON.parse(JSON.stringify(snapshot)) as PaperJournalSnapshot;

async function openShell(service: PaperTradingService, asViewer: WorkspaceViewerContext, revision = "r1") {
  const shell = await service.open({ requestRevision: revision }, asViewer).initial;
  if (shell.status !== "ready") throw new Error(`open failed: ${shell.status}`);
  return shell;
}

function usdRow(cash: readonly { currency: string; balance: number; reserved: number; available: number }[]) {
  const row = cash.find((entry) => entry.currency === "USD");
  if (!row) throw new Error("no USD cash row");
  return row;
}

// ---------------------------------------------------------------------------
// SPEC 1 — a read NEVER provisions
// ---------------------------------------------------------------------------

describe("ARCH-1 readAccount — SPEC 1: reads never provision", () => {
  it("1a. two reads on an empty service stay absent and commit ZERO durable writes", async () => {
    const store = new CountingStore();
    const service = makeService({ store });

    expect(await service.readAccount(viewer())).toEqual({ status: "absent" });
    expect(await service.readAccount(viewer())).toEqual({ status: "absent" });

    // The falsification: a lazy-provisioning read would have appended a genesis.
    expect(store.writes).toBe(0);
    // And nothing durable landed for a FRESH service to hydrate either.
    expect(await makeService({ store }).readAccount(viewer())).toEqual({ status: "absent" });
  });

  it("1b. after absent reads, open() still performs a NORMAL genesis — exactly once, at revision 1", async () => {
    const store = new CountingStore();
    const service = makeService({ store });
    await service.readAccount(viewer());
    await service.readAccount(viewer());

    const shell = await openShell(service, viewer());
    expect(shell.orders).toHaveLength(0);
    expect(usdRow(shell.cash)).toEqual({ currency: "USD", balance: 100_000, reserved: 0, available: 100_000 });

    // Genesis is the FIRST entry: revision 1. A read that half-created the
    // account (owner row, empty fold, ...) would land the genesis at 2+.
    const prepared = await service.prepare({ payload: limitBuy(1, 10) }, viewer());
    expect(prepared.status).toBe("issued");
    if (prepared.status !== "issued") return;
    expect(prepared.intent.accountRevision).toBe(1);

    // The account is durable now, and readAccount agrees with open().
    const read = await service.readAccount(viewer());
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.account).toEqual(shell.account);
  });

  it("1c. prepare() after absent reads still provisions (the other genesis door is unblocked)", async () => {
    const service = makeService();
    expect(await service.readAccount(viewer())).toEqual({ status: "absent" });

    const prepared = await service.prepare({ payload: limitBuy(10, 100) }, viewer());
    expect(prepared.status).toBe("issued");
    if (prepared.status !== "issued") return;
    expect(prepared.intent.accountRevision).toBe(1);
    expect(prepared.intent.environment).toBe("paper");

    const read = await service.readAccount(viewer());
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.account).toEqual(prepared.intent.account);
    expect(usdRow(read.cash).balance).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// SPEC 2 — hydration order (the historical bug: sync cache read before hydrate)
// ---------------------------------------------------------------------------

describe("ARCH-1 readAccount — SPEC 2: hydration precedes the answer", () => {
  it("2a. a NEW service over a populated store answers ready — readAccount is its FIRST call", async () => {
    const store = new MemoryPaperJournalStore();
    const seeded = await openShell(makeService({ store }), viewer());

    // Nothing else may hydrate the journal for this service: readAccount is the
    // very first thing it is ever asked to do.
    const restarted = makeService({ store });
    const read = await restarted.readAccount(viewer());

    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.account).toEqual(seeded.account);
    expect(usdRow(read.cash)).toEqual({ currency: "USD", balance: 100_000, reserved: 0, available: 100_000 });
  });

  it("2b. a restart sees the persisted ORDERS and reservations, not a ready-but-empty shell", async () => {
    const store = new MemoryPaperJournalStore();
    const service = makeService({ store });
    const shell = await openShell(service, viewer());
    const prepared = await service.prepare({ payload: limitBuy(10, 100) }, viewer());
    if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
    const submitted = await service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "arch1-hydrate", expectedRevision: String(prepared.intent.accountRevision) },
      viewer(),
    );
    expect(submitted.status).toBe("applied");

    const read = await makeService({ store }).readAccount(viewer());
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.account).toEqual(shell.account);
    expect(read.orders).toHaveLength(1);
    // Hand-worked: 10 × $100 reserved out of the $100,000 seed.
    expect(usdRow(read.cash)).toEqual({ currency: "USD", balance: 100_000, reserved: 1_000, available: 99_000 });
  });

  it("2c. genesis is ONCE across a restart: a second service with a different seed reads the ORIGINAL ledger", async () => {
    const store = new MemoryPaperJournalStore();
    await openShell(makeService({ store, seedCash: [{ amount: 1_000_000, currency: "KRW" }] }), viewer());

    const reseeder = makeService({ store, seedCash: [{ amount: 555, currency: "KRW" }] });
    const read = await reseeder.readAccount(viewer());

    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    const krw = read.cash.find((row: PaperCashRow) => row.currency === "KRW");
    // Neither 555 (re-seeded) nor 1,000,555 (double-seeded).
    expect(krw?.balance).toBe(1_000_000);
    expect(read.cash).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SPEC 3 + 4 — authorization, and denied outranking absent
// ---------------------------------------------------------------------------

describe("ARCH-1 readAccount — SPEC 3/4: authorization and existence secrecy", () => {
  it("3a. a guest is denied on a POPULATED service", async () => {
    const service = makeService();
    await openShell(service, viewer());
    expect(await service.readAccount(GUEST)).toEqual({ status: "denied" });
  });

  it("3b. a workspace viewer whose auth epoch no longer matches identity's is denied", async () => {
    let currentEpoch = "epoch:1";
    const service = makeService({ currentEpoch: () => currentEpoch });
    await openShell(service, viewer());

    // All-session revoke: identity moves, the viewer still carries the old epoch.
    currentEpoch = "epoch:2";
    expect(await service.readAccount(viewer())).toEqual({ status: "denied" });

    // Sanity: the account itself is untouched — a viewer at the current epoch reads it.
    const rotated = viewer({ accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:2") });
    const read = await service.readAccount(rotated);
    expect(read.status).toBe("ready");
  });

  it("4a. denied OUTRANKS absent: a guest on an EMPTY service learns nothing about existence", async () => {
    const empty = makeService();
    const populated = makeService();
    await openShell(populated, viewer());

    // The core leak probe: both answers must be byte-identical, so a guest
    // cannot distinguish "no account here" from "an account it may not see".
    const onEmpty = await empty.readAccount(GUEST);
    const onPopulated = await populated.readAccount(GUEST);
    expect(onEmpty).toEqual({ status: "denied" });
    expect(onEmpty).toEqual(onPopulated);
  });

  it("4b. a stale-epoch viewer on an EMPTY service is denied, never absent", async () => {
    const empty = makeService({ currentEpoch: () => "epoch:2" });
    const populated = makeService({ currentEpoch: () => "epoch:2" });
    // The populated one is provisioned by a viewer at the CURRENT epoch.
    const current = viewer({ accountAuthorizationEpoch: brandReference<string, "AccountAuthorizationEpoch">("epoch:2") });
    await openShell(populated, current);

    const stale = viewer(); // still carries epoch:1
    expect(await empty.readAccount(stale)).toEqual({ status: "denied" });
    expect(await populated.readAccount(stale)).toEqual({ status: "denied" });
  });

  it("4c. a denied answer carries NO account payload at all", async () => {
    const service = makeService();
    await openShell(service, viewer());
    const denied = await service.readAccount(GUEST);
    // Exactly one key: no account, cash, positions or orders smuggled alongside.
    expect(Object.keys(denied as Record<string, unknown>)).toEqual(["status"]);
  });
});

// ---------------------------------------------------------------------------
// SPEC 5 — workspace isolation
// ---------------------------------------------------------------------------

describe("ARCH-1 readAccount — SPEC 5: workspace isolation", () => {
  it("5. workspace B never observes workspace A's account", async () => {
    const store = new MemoryPaperJournalStore();
    const service = makeService({ store });
    const a = await openShell(service, viewer());

    // B is fully authorized — it simply owns nothing.
    expect(await service.readAccount(otherWorkspaceViewer())).toEqual({ status: "absent" });
    // A restarted service must not leak across the boundary during hydration either.
    expect(await makeService({ store }).readAccount(otherWorkspaceViewer())).toEqual({ status: "absent" });

    // A still sees its own after B's read (the read moved no ownership).
    const readA = await service.readAccount(viewer());
    expect(readA.status).toBe("ready");
    if (readA.status !== "ready") return;
    expect(readA.account).toEqual(a.account);
  });

  it("5b. B provisioning its own account leaves A's ledger untouched", async () => {
    const store = new MemoryPaperJournalStore();
    const service = makeService({ store });
    const a = await openShell(service, viewer());
    const b = await openShell(service, otherWorkspaceViewer(), "r-b");

    expect(b.account).not.toEqual(a.account);
    const readA = await service.readAccount(viewer());
    const readB = await service.readAccount(otherWorkspaceViewer());
    expect(readA.status).toBe("ready");
    expect(readB.status).toBe("ready");
    if (readA.status !== "ready" || readB.status !== "ready") return;
    expect(readA.account).toEqual(a.account);
    expect(readB.account).toEqual(b.account);
  });
});

// ---------------------------------------------------------------------------
// SPEC 6 — one projection, not two
// ---------------------------------------------------------------------------

describe("ARCH-1 readAccount — SPEC 6: representation parity with open()", () => {
  it("6. ready cash/positions/orders equal open()'s for the same state", async () => {
    const service = makeService();
    await openShell(service, viewer());
    const prepared = await service.prepare({ payload: limitBuy(10, 100) }, viewer());
    if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
    const submitted = await service.change(
      { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
      { idempotencyKey: "arch1-parity", expectedRevision: String(prepared.intent.accountRevision) },
      viewer(),
    );
    expect(submitted.status).toBe("applied");

    const read = await service.readAccount(viewer());
    const shell = await openShell(service, viewer(), "r2");
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;

    expect(read.account).toEqual(shell.account);
    expect(read.cash).toEqual(shell.cash);
    expect(read.positions).toEqual(shell.positions);
    expect(read.orders).toEqual(shell.orders);
    // Non-trivially: the parity is being checked on a state that HAS an order.
    expect(read.orders).toHaveLength(1);
    expect(usdRow(read.cash).reserved).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// SPEC 7 — storage failure is an exception, not a status
// ---------------------------------------------------------------------------

describe("ARCH-1 readAccount — SPEC 7: storage errors propagate", () => {
  it("7. a broken store throws — it is never swallowed into absent/denied", async () => {
    const service = makeService({ store: failingStore("arch1 store is down") });
    await expect(service.readAccount(viewer())).rejects.toThrow(/arch1 store is down/);
  });

  it("7b. store health never leaks through the error channel to an unauthorized viewer", async () => {
    // A guest against a BROKEN store gets the same plain `denied` it gets
    // against a healthy one — the throw of case 7 must not become an oracle
    // that tells an unauthenticated caller whether the database is up.
    const service = makeService({ store: failingStore("arch1 store is down") });
    await expect(service.readAccount(GUEST)).resolves.toEqual({ status: "denied" });
  });
});

// ---------------------------------------------------------------------------
// SPEC 9 — the projection is isolated from the ledger AND frozen
//
// Only reachable through a store whose load() rebuilds plain mutable objects,
// the way pg does. `storeWithSnapshot(inner, rehydrated)` above is that store.
// ---------------------------------------------------------------------------

/** A store with pg's hydration semantics over an in-memory ledger. */
function pgLikeStore(inner: PaperJournalStore): PaperJournalStore {
  return storeWithSnapshot(inner, rehydrated);
}

/**
 * A ledger holding one partially filled order — the state whose projection has
 * BOTH a nested `payload` and a non-empty `fills[]` to attack. The fill is
 * appended through the journal seam the lifecycle/simulator harnesses use
 * (tests/f8-journal-boundary.test.ts), since the service exposes no fill door.
 */
async function seedFilledOrder(store: PaperJournalStore) {
  const service = makeService({ store });
  const shell = await openShell(service, viewer());
  const prepared = await service.prepare({ payload: limitBuy(10, 100) }, viewer());
  if (prepared.status !== "issued") throw new Error(`prepare failed: ${prepared.status}`);
  const submitted = await service.change(
    { kind: "submit", account: prepared.intent.account, intent: prepared.intent.reference },
    { idempotencyKey: "arch1-frozen", expectedRevision: String(prepared.intent.accountRevision) },
    viewer(),
  );
  if (submitted.status !== "applied") throw new Error(`submit failed: ${submitted.status}`);
  const fill: PaperFill = {
    identity: brandReference<string, "PaperFillIdentity">("fill:arch1-frozen"),
    order: submitted.order,
    quantity: 4,
    price: { amount: 99.5, currency: "USD" },
    // Strictly after acceptance (NOW) — the boundary refuses fills at/before it.
    eventTime: LATER,
    receivedAt: LATER,
    evidenceReference: "evidence:arch1-frozen",
    policyVersion: "simulation-v1",
  };
  const applied = await service.journal.appendSystem(WS_A, shell.account, String(fill.identity), { kind: "fill_applied", fill });
  if (applied.status !== "applied") throw new Error(`fill rejected: ${applied.status}`);
  return shell.account;
}

describe("ARCH-1 readAccount — SPEC 9: the projection is isolated and frozen", () => {
  it("9a. readAccount's order payload/fills refuse mutation (TypeError) and the ledger is unchanged", async () => {
    const ledger = new MemoryPaperJournalStore();
    await seedFilledOrder(ledger);

    // Meta-guard: the wrapper must really strip the in-memory store's freezing,
    // or this case silently loses its teeth. pg hands back plain JSONB rows.
    const hydrationRows = await pgLikeStore(ledger).load();
    expect(Object.isFrozen(hydrationRows.entries[0]!.entry)).toBe(false);

    // A service that HYDRATES from pg-like rows: nothing it folds was frozen by
    // the in-memory store, so an unprotected projection leaks live objects here.
    const durable = makeService({ store: pgLikeStore(ledger) });
    const read = await durable.readAccount(viewer());
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    const order = read.orders[0]!;
    expect(order.payload.quantity).toBe(10);
    expect(order.fills).toHaveLength(1);

    // Falsification 2 (frozen): every attempt is LOUD, not silently dropped.
    expect(() => {
      (order.payload as { quantity: number }).quantity = 999;
    }).toThrow(TypeError);
    expect(() => {
      (order.payload.limitPrice as { amount: number }).amount = 0.01;
    }).toThrow(TypeError);
    expect(() => {
      (order.fills as PaperFill[]).push(order.fills[0]!);
    }).toThrow(TypeError);
    expect(() => {
      (order.fills[0]!.price as { amount: number }).amount = 1;
    }).toThrow(TypeError);
    expect(() => {
      (order as { filledQuantity: number }).filledQuantity = 10;
    }).toThrow(TypeError);
    expect(() => {
      (read.orders as unknown[]).pop();
    }).toThrow(TypeError);

    // Falsification 1 (isolated): read again — through the SAME service and
    // through an independent hydration — and the ledger is the hand-worked one.
    for (const again of [await durable.readAccount(viewer()), await makeService({ store: pgLikeStore(ledger) }).readAccount(viewer())]) {
      expect(again.status).toBe("ready");
      if (again.status !== "ready") continue;
      const row = again.orders[0]!;
      expect(row.payload.quantity).toBe(10);
      expect(row.payload.limitPrice).toEqual({ amount: 100, currency: "USD" });
      expect(row.filledQuantity).toBe(4);
      expect(row.fills).toHaveLength(1);
      expect(row.fills[0]!.price).toEqual({ amount: 99.5, currency: "USD" });
    }
  });

  it("9b. open()'s shell is frozen the same way, and freezing never lands ON the live ledger", async () => {
    const ledger = new MemoryPaperJournalStore();
    const account = await seedFilledOrder(ledger);
    const durable = makeService({ store: pgLikeStore(ledger) });

    const shell = await openShell(durable, viewer(), "r-frozen");
    const order = shell.orders[0]!;
    expect(() => {
      (order.payload as { quantity: number }).quantity = 999;
    }).toThrow(TypeError);
    expect(() => {
      (order.fills[0]!.price as { amount: number }).amount = 1;
    }).toThrow(TypeError);
    expect(() => {
      (shell.cash as unknown[]).pop();
    }).toThrow(TypeError);

    // The complement of "isolated": if the projection had frozen the LIVE fold
    // objects in place instead of copying, the next fold over that same order
    // would throw. It must still accept a second fill and move money.
    const second: PaperFill = {
      identity: brandReference<string, "PaperFillIdentity">("fill:arch1-frozen-2"),
      order: order.order,
      quantity: 6,
      price: { amount: 99.5, currency: "USD" },
      eventTime: LATER,
      receivedAt: LATER,
      evidenceReference: "evidence:arch1-frozen-2",
      policyVersion: "simulation-v1",
    };
    const applied = await durable.journal.appendSystem(WS_A, account, String(second.identity), { kind: "fill_applied", fill: second });
    expect(applied.status).toBe("applied");

    const after = await durable.readAccount(viewer());
    expect(after.status).toBe("ready");
    if (after.status !== "ready") return;
    expect(after.orders[0]!.filledQuantity).toBe(10);
    expect(after.positions[0]!.quantity).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// SPEC 10 — an owner mismatch is `denied`
//
// UNREACHABLE through the public API: the account reference is a pure function
// of the workspace, so provisioning always records owner == workspace. This is
// the DB-corruption / partial-restore defense, so the only way to state it is
// to forge the hydration snapshot.
// ---------------------------------------------------------------------------

describe("ARCH-1 readAccount — SPEC 10: an account owned elsewhere is denied", () => {
  it("10. a forged snapshot whose owner row names another workspace reads denied, not ready (unreachable-by-API defense)", async () => {
    const ledger = new MemoryPaperJournalStore();
    await openShell(makeService({ store: ledger }), viewer());

    // Control: the same rows, unforged, are `ready` — so the difference below
    // is the owner row and nothing else.
    expect((await makeService({ store: pgLikeStore(ledger) }).readAccount(viewer())).status).toBe("ready");

    const stolen = storeWithSnapshot(ledger, (snapshot) => ({
      ...rehydrated(snapshot),
      owners: snapshot.owners.map((row) => ({ ...row, workspace: "workspace:thief" })),
    }));
    // Not `ready` (the ledger is not this workspace's to serve) and not
    // `absent` (the entries plainly exist under this workspace) — `denied`.
    expect(await makeService({ store: stolen }).readAccount(viewer())).toEqual({ status: "denied" });
    // The owner row must have actually been forged, or the case proves nothing.
    expect((await ledger.load()).owners.map((row) => row.workspace)).toEqual([WS_A]);
  });
});

// ---------------------------------------------------------------------------
// Surface SPEC — the `paper.account` operation and the CLI account surface
//
// NO postgres block here, deliberately. Every durable paper surface drives ONE
// fixed production ledger, and tests/persistence/paper-cli.pg.test.ts already
// TRUNCATEs those five tables in its beforeAll. vitest runs test FILES in
// parallel workers and neither `describe.sequential` (in-file only) nor
// per-case cleanup can order two files, so a durable block here would
// nondeterministically shred — or be shredded by — that file's genesis. The
// clause it would have pinned ("a second open with a different seed keeps the
// ORIGINAL ledger") is blind-covered at the service seam by case 2c above, and
// durably by the pre-existing paper-cli.pg.test.ts. Consequence, stated for the
// gate: NOTHING in this file needs postgres, so nothing in it is unverified —
// every case below was actually executed (the local pg container could not be
// authenticated against, so an unrunnable durable block would have shipped
// unverified as well).
// ---------------------------------------------------------------------------

const SENTINEL = "NOT-A-REAL-SECRET-arch1-blind-probe";
// Assembled from parts so no credential-shaped literal exists in the source.
const BOGUS_DSN = ["postgresql://arch1_probe_user", ":", SENTINEL, "@127.0.0.1:1/arch1probe"].join("");

/** A pool whose every call rejects carrying driver text that must reach no caller. */
function poisonedPool(): Pool {
  const boom = () => Promise.reject(new Error(`connection to ${BOGUS_DSN} failed: password authentication failed`));
  return { connect: boom, query: boom, end: () => Promise.resolve() } as unknown as Pool;
}

/**
 * Three causes used to collapse onto `reason: "unavailable"`. One of them —
 * "nothing is broken, this surface was never given a database" — now has its
 * OWN reason, `configuration_required`, because the caller's next move differs:
 * configure and re-call, versus wait and retry. Case 8 pins that split in both
 * directions, since a reason an agent is told to branch on is a contract.
 *
 * TWO causes still share `unavailable` — the driver failing, and a read refused
 * by an authorization drift — and they part only on the MESSAGE, so the
 * message-pinning principle stands. The poisoned pool is what makes that
 * discrimination real: `DRIVER_DOWN` can only be produced by a call that was
 * ADMITTED and went on to touch storage, so "everything is refused now" cannot
 * masquerade as this green. `READ_REFUSED` needs a LIVE database to reach (the
 * CLI composition always supplies its own viewer), so this file can only assert
 * that the driver arm never wears it.
 */
const DRIVER_DOWN = "database unavailable";
const READ_REFUSED = "paper account is not readable on this surface";
const NO_DATABASE = "no database is configured for this surface";

describe("ARCH-1 surface — paper.account operation", () => {
  it("8. a broken driver refuses `unavailable` with the DRIVER message, never throws, and never echoes the connection text", async () => {
    // The pool is INJECTED, so this reaches the durable path and fails inside
    // the driver — a dead dependency, not a missing setting.
    const result = await operationCatalog({ pool: () => poisonedPool() }).call("paper.account", {});
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toBe("unavailable");
    // The message the reason alone cannot carry: this call was ADMITTED and
    // died in the driver, so it is NOT the sibling `unavailable` cause.
    expect(result.message).toBe(DRIVER_DOWN);
    expect(result.message).not.toBe(READ_REFUSED);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("password authentication failed");
  });

  // Deliberately unnumbered: the "8a/8b/…" prefixes belong to the SPEC 8
  // assembly block below, and reusing them here would read as the same case.
  it("reason split: an unconfigured surface refuses `configuration_required`, and the split holds in BOTH directions", async () => {
    // Same operation, same arguments; only the pool differs. If the reasons do
    // not diverge on that alone, the split an agent is told to branch on is
    // prose, not behaviour.
    const unconfigured = await operationCatalog().call("paper.account", {});
    const brokenDriver = await operationCatalog({ pool: () => poisonedPool() }).call("paper.account", {});
    expect(unconfigured.status).toBe("refused");
    expect(brokenDriver.status).toBe("refused");
    if (unconfigured.status !== "refused" || brokenDriver.status !== "refused") return;

    expect(unconfigured.reason).toBe("configuration_required");
    expect(unconfigured.message).toBe(NO_DATABASE);

    // Neither reason appears in the other's situation: a missing setting is not
    // a dead dependency to wait on, and a dead dependency is not something the
    // caller can fix by configuring anything.
    expect(unconfigured.reason).not.toBe(brokenDriver.reason);
    expect(unconfigured.reason).not.toBe("unavailable");
    expect(brokenDriver.reason).not.toBe("configuration_required");
    expect(brokenDriver.message).not.toBe(NO_DATABASE);
  });

  it("9. the CLI account surface reports api/2 with the DRIVER message and leaks no connection text", async () => {
    const outcome = await paperAccountCommand({ pool: poisonedPool() });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.envelope.ok).toBe(false);
    if (outcome.envelope.ok) return;
    expect(outcome.envelope.error.code).toBe("api");
    // Same discrimination as case 8: the CLI reached storage. A CLI whose
    // viewer stopped being admitted would refuse without a driver message.
    expect(outcome.envelope.error.message).toBe(DRIVER_DOWN);
    const serialized = JSON.stringify(outcome.envelope);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("password authentication failed");
  });
});

// ---------------------------------------------------------------------------
// SPEC 8 — the composition admits its OWN workspace and no other
//
// No postgres: an unusable pool is the oracle. `readAccount` adjudicates BEFORE
// it touches storage (case 7b pins that), so a poisoned pool makes admission
// observable — `denied` is the only non-throwing answer, and the moment the
// guard admits a foreign workspace the call reaches the driver and the
// assertion dies on a rejected promise instead of a merely wrong status.
// `open`/`prepare` hydrate FIRST and adjudicate after (observed here, and worth
// knowing: a foreign caller can force a database round trip through those two,
// which `readAccount` does not permit), so 8d swaps in a pool that hydrates an
// empty ledger. Both halves carry a mirror case where the CLI's own viewer is
// NOT denied, so a blanket "deny everyone" regression cannot paint this green.
// ---------------------------------------------------------------------------

const OUTSIDE_WORKSPACE = brandReference<string, "WorkspaceReference">("other:ws");

/** The CLI's own credentials, re-pointed at a workspace the composition does not own. */
function outsider(epoch?: string): ViewerContext {
  const claimed = { ...cliViewer(), workspaceReference: OUTSIDE_WORKSPACE };
  if (epoch === undefined) return claimed; // keeps the CLI's REAL authorization epoch
  return { ...claimed, accountAuthorizationEpoch: epoch as WorkspaceViewerContext["accountAuthorizationEpoch"] };
}

/**
 * Values a caller could plausibly guess for "the epoch the composition hands a
 * workspace it refuses". A previous implementation answered non-CLI workspaces
 * with a constant of exactly this shape, so carrying the constant back in the
 * viewer authorized the caller. `undefined` is in the list because the identity
 * port's own return type admits it — the cheapest possible sentinel to collide.
 */
const GUESSED_REFUSAL_SENTINELS: readonly (string | undefined)[] = [
  CLI_WORKSPACE,
  "cli:not-this-surface",
  "cli:denied",
  "cli:local:epoch",
  "epoch:cli:local",
  "other:ws",
  "denied",
  "",
  undefined,
];

/**
 * A pool that answers every statement with zero rows — enough for the durable
 * store's read path (BEGIN → the five SELECTs → COMMIT) to hydrate an EMPTY
 * ledger without a database.
 */
function emptyPool(): Pool {
  const query = () => Promise.resolve({ rows: [], rowCount: 0 });
  const client = { query, release: () => undefined };
  return { connect: () => Promise.resolve(client), query, end: () => Promise.resolve() } as unknown as Pool;
}

describe("ARCH-1 assembly — SPEC 8: the composition authorizes ONE workspace", () => {
  function durable() {
    return createDurablePaperTrading({ pool: poisonedPool(), seedCash: SEED_USD, now: () => NOW });
  }

  it("8a. the CLI's own viewer IS admitted — it reaches storage and dies in the driver", async () => {
    // The anti-tautology control for every case below: if the composition ever
    // starts denying everyone, this line fails and the section stops being a
    // vacuous green.
    await expect(durable().readAccount(cliViewer())).rejects.toThrow(/password authentication failed/);
    expect(String(cliViewer().workspaceReference)).toBe(CLI_WORKSPACE);
  });

  it("8b. a viewer claiming another workspace is denied — with the CLI's own epoch", async () => {
    const service = durable();
    expect(await service.readAccount(outsider())).toEqual({ status: "denied" });
  });

  it("8c. no guessed refusal sentinel buys admission for a foreign workspace", async () => {
    const service = durable();
    for (const guess of GUESSED_REFUSAL_SENTINELS) {
      // A rejected promise here means the guess AUTHORIZED the outsider and the
      // call went on to touch the database. `denied` is the only pass.
      expect(await service.readAccount(outsider(guess))).toEqual({ status: "denied" });
    }
  });

  it("8d. genesis is sealed too: open() and prepare() refuse the same outsiders", async () => {
    // open()/prepare() hydrate BEFORE they adjudicate (readAccount does not), so
    // the poisoned pool would mask the answer with a driver error. This pool
    // hydrates an EMPTY ledger instead: an admitted outsider would come back
    // `ready`/`issued` (or provision), never `denied`.
    const service = createDurablePaperTrading({ pool: emptyPool(), seedCash: SEED_USD, now: () => NOW });
    for (const guess of GUESSED_REFUSAL_SENTINELS) {
      const who = outsider(guess);
      expect(await service.open({ requestRevision: "r-outsider" }, who).initial).toEqual({ status: "denied" });
      expect(await service.prepare({ payload: limitBuy(1, 10) }, who)).toEqual({ status: "denied" });
    }
    expect(await service.open({ requestRevision: "r-outsider" }, outsider()).initial).toEqual({ status: "denied" });
    expect(await service.prepare({ payload: limitBuy(1, 10) }, outsider())).toEqual({ status: "denied" });

    // Anti-tautology control: the CLI's own viewer is NOT denied on this pool,
    // so the denials above are the workspace guard, not a dead genesis door.
    expect((await service.open({ requestRevision: "r-cli" }, cliViewer()).initial).status).not.toBe("denied");
    expect((await service.prepare({ payload: limitBuy(1, 10) }, cliViewer())).status).not.toBe("denied");
  });

  it("8e. a guest is denied by the composition as well, and learns nothing about storage health", async () => {
    expect(await durable().readAccount(GUEST)).toEqual({ status: "denied" });
  });
});

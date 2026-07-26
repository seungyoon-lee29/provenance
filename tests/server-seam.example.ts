// COMPILE-TIME FIXTURE, not a runnable gate, and a NARROW one — measured, not assumed.
//
// What it pins: that `src/shared` still exports each public port NAME. Renaming or
// deleting one fails `npm run typecheck` (verified: TS2724).
// What it does NOT pin: the ports' SHAPES. Nothing here implements them, so changing
// a method signature in module-interfaces.ts is NOT caught (verified: typecheck stays
// green). Do not read this file as a contract test.
//
// Every import is `import type`, so executing it loads nothing and proves nothing: the
// npm scripts that "ran" these printed "passed" even with the imported module rigged to
// throw, and were removed 2026-07-26 (see scripts/gates/gate-ledger.txt). `tsc` covers
// both files, which is where the remaining value lives.
import type {
  checkRuntimeDependencies,
  closeRuntimeDependencies,
  getDatabasePool,
  getRedisClient,
} from "../src/platform/runtime/dependencies";

// The prior server-only contracts barrel was retired along with the
// external-broker execution modules it described (2026-07-22 pivot).
// `src/platform/runtime/dependencies.ts` is the surviving server-only
// module (real `pg`/`redis` clients that must never reach a client
// bundle), so the seam check now pins its shape instead.
type ServerOnlyRuntimeDependencies = Readonly<{
  getDatabasePool: typeof getDatabasePool;
  getRedisClient: typeof getRedisClient;
  checkRuntimeDependencies: typeof checkRuntimeDependencies;
  closeRuntimeDependencies: typeof closeRuntimeDependencies;
}>;

function acceptsServerOnlyRuntimeDependencies(deps: ServerOnlyRuntimeDependencies) {
  return deps;
}

void acceptsServerOnlyRuntimeDependencies;

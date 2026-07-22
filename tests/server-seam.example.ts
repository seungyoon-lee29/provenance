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
process.stdout.write("server-only seam example passed\n");

import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";

import { DEFAULT_DATABASE_URL, DEFAULT_REDIS_URL } from "./defaults";

type RuntimeGlobals = typeof globalThis & {
  __fakeBloombergPool?: Pool;
  __fakeBloombergRedis?: RedisClientType;
  __fakeBloombergRedisConnect?: Promise<RedisClientType>;
};

const runtimeGlobals = globalThis as RuntimeGlobals;
const dependencyTimeoutMs = 1_000;

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

function redisUrl(): string {
  return process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
}

export function getDatabasePool(): Pool {
  runtimeGlobals.__fakeBloombergPool ??= new Pool({
    connectionString: databaseUrl(),
    connectionTimeoutMillis: dependencyTimeoutMs,
    max: 5,
    query_timeout: dependencyTimeoutMs,
    statement_timeout: dependencyTimeoutMs,
  });
  return runtimeGlobals.__fakeBloombergPool;
}

export async function getRedisClient(): Promise<RedisClientType> {
  if (runtimeGlobals.__fakeBloombergRedis?.isReady) {
    return runtimeGlobals.__fakeBloombergRedis;
  }
  if (runtimeGlobals.__fakeBloombergRedis?.isOpen && runtimeGlobals.__fakeBloombergRedisConnect === undefined) {
    runtimeGlobals.__fakeBloombergRedis.destroy();
    runtimeGlobals.__fakeBloombergRedis = undefined;
  }
  if (runtimeGlobals.__fakeBloombergRedis === undefined) {
    runtimeGlobals.__fakeBloombergRedis = createClient({
      url: redisUrl(),
      socket: {
        connectTimeout: dependencyTimeoutMs,
        reconnectStrategy: false,
      },
    });
    runtimeGlobals.__fakeBloombergRedis.on("error", () => undefined);
  }
  const client = runtimeGlobals.__fakeBloombergRedis;
  runtimeGlobals.__fakeBloombergRedisConnect ??= new Promise<RedisClientType>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (client.isOpen) client.destroy();
      reject(new Error("Redis connection timed out"));
    }, dependencyTimeoutMs);
    client.connect().then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(client);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
  try {
    return await runtimeGlobals.__fakeBloombergRedisConnect;
  } catch (error) {
    if (runtimeGlobals.__fakeBloombergRedis?.isOpen) runtimeGlobals.__fakeBloombergRedis.destroy();
    runtimeGlobals.__fakeBloombergRedis = undefined;
    runtimeGlobals.__fakeBloombergRedisConnect = undefined;
    throw error;
  }
}

async function pingRedis(client: RedisClientType): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    if (client.isOpen) client.destroy();
  }, dependencyTimeoutMs);
  try {
    return await client.withAbortSignal(controller.signal).ping();
  } finally {
    clearTimeout(timeout);
    if (!client.isReady) {
      runtimeGlobals.__fakeBloombergRedis = undefined;
      runtimeGlobals.__fakeBloombergRedisConnect = undefined;
    }
  }
}

export async function checkRuntimeDependencies() {
  try {
    const pool = getDatabasePool();
    const [database, redisReply] = await Promise.all([
      pool.query<{ current_version: string }>("SELECT COALESCE(MAX(version), 'none') AS current_version FROM schema_migrations"),
      getRedisClient().then(pingRedis),
    ]);
    const migration = database.rows[0]?.current_version ?? "none";
    if (migration === "none" || redisReply !== "PONG") {
      throw new Error("required runtime dependency is not ready");
    }
    return { service: "runtime", status: "ready" as const, dependencies: { postgres: "ready", redis: "ready", migration } };
  } catch {
    return { service: "runtime", status: "not_ready" as const, dependencies: { postgres: "unavailable", redis: "unavailable" } };
  }
}

export async function closeRuntimeDependencies(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (runtimeGlobals.__fakeBloombergRedis?.isOpen) tasks.push(runtimeGlobals.__fakeBloombergRedis.quit());
  if (runtimeGlobals.__fakeBloombergPool) tasks.push(runtimeGlobals.__fakeBloombergPool.end());
  await Promise.allSettled(tasks);
  runtimeGlobals.__fakeBloombergRedis = undefined;
  runtimeGlobals.__fakeBloombergRedisConnect = undefined;
  runtimeGlobals.__fakeBloombergPool = undefined;
}

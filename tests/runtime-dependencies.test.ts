import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { closeRuntimeDependencies, getDatabasePool, getRedisClient } from "../src/platform/runtime/dependencies";

async function unresponsiveTcpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

afterEach(async () => {
  await closeRuntimeDependencies();
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});

describe("runtime dependency deadlines", () => {
  it("bounds a PostgreSQL server that accepts TCP but never completes startup", async () => {
    const fixture = await unresponsiveTcpServer();
    process.env.DATABASE_URL = `postgresql://test:test@127.0.0.1:${fixture.port}/test`;
    const started = Date.now();
    await expect(getDatabasePool().query("SELECT 1")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    await fixture.close();
  });

  it("bounds a Redis server that accepts TCP but never completes startup", async () => {
    const fixture = await unresponsiveTcpServer();
    process.env.REDIS_URL = `redis://127.0.0.1:${fixture.port}`;
    const started = Date.now();
    await expect(getRedisClient()).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
    await fixture.close();
  });
});

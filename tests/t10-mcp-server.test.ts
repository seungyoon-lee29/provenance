import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";

import { CALL_OPERATION, createMcpServer, DESCRIBE_OPERATION, LIST_OPERATIONS, SERVER_NAME } from "../src/mcp/server";
import { operationCatalog } from "../src/operations/catalog";

/**
 * T10 S3 slice regression (progress/t10-strategy-cli-mcp.md).
 *
 * Driven through a REAL MCP client over the SDK's linked in-memory transport,
 * so the handshake, tool listing and tool-call framing are exercised by the
 * protocol implementation rather than by assertions about our own objects.
 * Network-off and deterministic — no process spawn, no sockets.
 *
 * Blind acceptance authorship is a separate agent at the tier-top gate.
 */

const SERIES = {
  instrument: "instr:BT",
  venue: "KRX",
  currency: "KRW",
  bars: [
    { periodStart: "2026-01-05T06:30:00.000Z", close: 10_000, volume: 1_000_000, complete: true },
    { periodStart: "2026-01-06T06:30:00.000Z", close: 10_200, volume: 1_000_000, complete: true },
    { periodStart: "2026-01-07T06:30:00.000Z", close: 10_400, volume: 1_000_000, complete: true },
  ],
};

let client: Client;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(operationCatalog());
  const connected = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverTransport), connected.connect(clientTransport)]);
  return connected;
}

/** The single text block a tool returns, parsed back into data. */
function body(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as readonly { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe("text");
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  client = await connect();
});

describe("T10 S3 — MCP stdio server", () => {
  it("completes the handshake and advertises itself", async () => {
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it("exposes EXACTLY three tools regardless of catalog size", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([CALL_OPERATION, DESCRIBE_OPERATION, LIST_OPERATIONS].sort());
    // The resident context cost is three schemas; operations are discovered.
    expect(tools.length).toBeLessThan(operationCatalog().list().length + 3);
    for (const tool of tools) expect(tool.description?.length ?? 0).toBeGreaterThan(0);
  });

  it("discovers operations and their input schema through the catalog tools", async () => {
    const listed = body(await client.callTool({ name: LIST_OPERATIONS, arguments: {} }));
    const operations = listed.operations as readonly { operation: string; kind: string }[];
    expect(operations.map((entry) => entry.operation)).toContain("backtest.run");
    // Ticket 41: no write operation is reachable from this surface.
    expect(operations.every((entry) => entry.kind === "read" || entry.kind === "compute")).toBe(true);

    const described = body(await client.callTool({ name: DESCRIBE_OPERATION, arguments: { operation: "backtest.run" } }));
    expect(described.kind).toBe("compute");
    expect((described.input as { type?: string }).type).toBe("object");
  });

  it("returns a domain refusal as a SUCCESSFUL call carrying its reason", async () => {
    const result = await client.callTool({
      name: CALL_OPERATION,
      arguments: { operation: "backtest.run", input: { series: { ...SERIES, bars: [] }, strategy: { name: "buy_and_hold" }, cash: 1_000 } },
    });
    // Not an error: the CALL was fine. The answer is "refused, and here is why".
    expect(result.isError).toBeFalsy();
    expect(body(result).outcome).toEqual({ status: "refused", reason: "empty_series" });
  });

  it("flags an operation-layer refusal as an error the caller must fix", async () => {
    const unknown = await client.callTool({ name: CALL_OPERATION, arguments: { operation: "backtest.nuke" } });
    expect(unknown.isError).toBe(true);
    expect(body(unknown).error).toBe("unknown_operation");

    const badParams = await client.callTool({
      name: CALL_OPERATION,
      arguments: { operation: "backtest.run", input: { series: SERIES, strategy: { name: "sma_cross", params: { fast: 9, slow: 2 } }, cash: 1_000 } },
    });
    expect(badParams.isError).toBe(true);
    expect(body(badParams).error).toBe("invalid_params");

    const missing = await client.callTool({ name: DESCRIBE_OPERATION, arguments: { operation: "nope" } });
    expect(missing.isError).toBe(true);
  });

  it("delivers coverage-typed metrics unflattened", async () => {
    const value = body(
      await client.callTool({
        name: CALL_OPERATION,
        arguments: { operation: "backtest.run", input: { series: SERIES, strategy: { name: "buy_and_hold" }, cash: 1_000_000 } },
      }),
    );
    const performance = (value.outcome as { performance: Record<string, unknown> }).performance;
    // A metric that cannot be computed keeps its reason instead of becoming 0.
    expect(performance.winRate).toEqual({ status: "unavailable", reason: "no_sells" });
    expect((performance.timeWeightedReturn as { status: string }).status).toBe("covered");
  });

  it("answers honestly when a durable operation has no database (server stays up)", async () => {
    const result = await client.callTool({ name: CALL_OPERATION, arguments: { operation: "paper.account" } });
    expect(result.isError).toBe(true);
    expect(body(result).error).toBe("unavailable");
    // Still serving afterwards — a missing dependency is not a startup failure.
    expect((await client.listTools()).tools).toHaveLength(3);
  });

  it("imports only the stdio transport — the HTTP ones pull in hono/express", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url)), "utf8");
    const sdkImports = [...source.matchAll(/from "(@modelcontextprotocol\/sdk\/[^"]+)"/g)].map((match) => match[1]);
    expect(sdkImports.length).toBeGreaterThan(0);
    for (const specifier of sdkImports) {
      // `npm audit`'s moderate advisory lives in @hono/node-server, reachable
      // only through the HTTP transports. Keeping this file's SDK imports to
      // stdio + mcp is what makes "not reachable" a checked fact, not a claim.
      expect(specifier).not.toMatch(/streamableHttp|sse|express/);
    }
  });
});

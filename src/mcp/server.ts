import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { jsonSchemaOf, operationCatalog } from "../operations/catalog";
import type { OperationCatalog, OperationDependencies } from "../operations/catalog";

/**
 * T10 S3 — MCP stdio server.
 *
 * The SECOND transport over `operations/catalog.ts`. The CLI is the first. This
 * file owns protocol framing and nothing else: it must not decide what an
 * operation means, because a second definition drifts from the first.
 *
 * THREE TOOLS, FIXED (ticket 41). Tool schemas sit in the agent's context
 * permanently, so exposing one tool per operation would spend resident context
 * proportional to the catalog. `list_operations` → `describe_operation` →
 * `call_operation` keeps that cost at three however many operations exist.
 *
 * STDOUT IS THE PROTOCOL. Every byte on stdout is JSON-RPC framing; a stray
 * `console.log` anywhere in the imported graph corrupts the stream and the
 * client disconnects on a parse error. Diagnostics go to stderr, always. Same
 * discipline as the CLI's `--json` purity, with a harder failure mode.
 *
 * CONTEXT MODEL (ticket 41 decision 1): a local stdio process owned by whoever
 * launched it — not a web session, which Stage 3 removes anyway. The catalog
 * holds no `write` operation, so this surface cannot move money.
 *
 * TRANSPORT: stdio only. The SDK's HTTP transports (`streamableHttp`, `sse`,
 * `express`) are deliberately never imported — they are what pull hono/express
 * into the runtime graph, and `tests/t10-mcp-server.test.ts` asserts this
 * file's import list to keep it that way.
 */

export const SERVER_NAME = "provenance";
export const SERVER_VERSION = "0.1.0";

export const LIST_OPERATIONS = "list_operations";
export const DESCRIBE_OPERATION = "describe_operation";
export const CALL_OPERATION = "call_operation";

/** Mutable by necessity, not by preference: the SDK's `ToolCallback` return
 * type declares `content` as a mutable array, and a `readonly` one does not
 * satisfy it. Nothing here mutates the value after construction. */
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** One JSON body per tool result: agents parse it, humans can read it. */
function jsonResult(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/**
 * Wire the three tools onto a catalog. Exported so tests can drive the server
 * over an in-memory transport instead of spawning a process.
 */
export function createMcpServer(catalog: OperationCatalog): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    LIST_OPERATIONS,
    {
      description:
        "List every available operation with its kind (read = no state change, compute = deterministic in-memory run) and a one-line summary. Call this first: it is cheap and it is the only way to learn what exists.",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        operations: catalog.list().map(({ name, kind, summary }) => ({ operation: name, kind, summary })),
      }),
  );

  server.registerTool(
    DESCRIBE_OPERATION,
    {
      description:
        "Fetch the JSON Schema of one operation's input. Cross-field rules (for example fast < slow) cannot be expressed in JSON Schema and do not appear here; they are still enforced, and a violation comes back as a refusal carrying the reason.",
      inputSchema: { operation: z.string().describe("Operation name from list_operations.") },
    },
    async ({ operation }) => {
      const definition = catalog.find(operation);
      if (definition === undefined) {
        // The caller named something that does not exist — an error for them to
        // fix, so it is flagged rather than presented as an answer.
        return jsonResult(
          { error: "unknown_operation", message: `unknown operation "${operation}"`, known: catalog.list().map((entry) => entry.name) },
          true,
        );
      }
      return jsonResult({
        operation: definition.name,
        kind: definition.kind,
        summary: definition.summary,
        input: jsonSchemaOf(definition.inputSchema),
      });
    },
  );

  server.registerTool(
    CALL_OPERATION,
    {
      description:
        "Run an operation. The result comes back WHOLE and is never flattened: a refused backtest is a SUCCESSFUL call carrying {status:'refused', reason}, and a metric that could not be computed stays {status:'unavailable', reason} instead of becoming 0 or null. Read those reasons — they separate 'no data' from 'not permitted' from 'not computable'.",
      inputSchema: {
        operation: z.string().describe("Operation name from list_operations."),
        input: z.record(z.string(), z.unknown()).optional().describe("Operation input; see describe_operation."),
      },
    },
    async ({ operation, input }) => {
      const result = await catalog.call(operation, input ?? {});
      if (result.status === "refused") {
        // An operation-layer refusal means the CALL was wrong (bad name, bad
        // input): the agent should fix it and retry, so it is flagged. A DOMAIN
        // refusal — a backtest that could not run — travels inside `ok` with
        // its reason intact: the call was fine, the answer is "refused, here is
        // why". Collapsing the two would destroy exactly the distinction this
        // surface exists to carry.
        return jsonResult({ error: result.reason, message: result.message }, true);
      }
      return jsonResult(result.value);
    },
  );

  return server;
}

/**
 * Entry point. A missing database is NOT a startup failure: the server comes up
 * and `paper.account` answers `unavailable` (ticket 41 — no credentials means
 * the operation returns an outcome and the server stays up). The pool factory
 * is lazy, so nothing connects until a durable operation is actually called.
 */
export async function main(): Promise<void> {
  const dependencies: OperationDependencies = {};
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL.length > 0) {
    // Imported lazily: loading the pg runtime is pointless for a stdio server
    // that may never touch the database.
    const { getDatabasePool } = await import("../platform/runtime/dependencies");
    Object.assign(dependencies, { pool: () => getDatabasePool() });
  }
  const server = createMcpServer(operationCatalog(dependencies));
  await server.connect(new StdioServerTransport());
  // Never write to stdout here — the transport owns it.
  process.stderr.write(`${SERVER_NAME} MCP server ready on stdio\n`);
}

/**
 * T10 BLIND gate — S3 (MCP stdio server).
 *
 * Written WITHOUT reading src/mcp/**, src/operations/**, src/cli/**,
 * src/modules/paper-trading/backtest/** or the implementer's own
 * tests/t10-*.test.ts. Every assertion below was derived from SKILL.md,
 * README.md and from executing the real server as a child process and
 * observing what came back over stdio.
 *
 * The server is spawned for real and spoken to with hand-written
 * newline-delimited JSON-RPC — no MCP client SDK — precisely so that
 * stdout can be inspected byte for byte. The transport dies if one
 * non-protocol byte reaches stdout, so that is a first-class assertion
 * here, not an afterthought.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const EXPECTED_TOOLS = ["list_operations", "describe_operation", "call_operation"] as const;
const EXPECTED_OPERATIONS = [
  "strategy.list",
  "strategy.describe",
  "backtest.run",
  "paper.account",
] as const;

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: {
    isError?: boolean;
    content?: { type: string; text?: string }[];
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// black-box stdio session
// ---------------------------------------------------------------------------

const liveSessions = new Set<McpSession>();

class McpSession {
  readonly child: ChildProcessWithoutNullStreams;
  /** every complete line the server wrote to stdout */
  readonly stdoutLines: string[] = [];
  /** lines on stdout that were NOT a JSON-RPC 2.0 message — must stay empty */
  readonly stdoutPollution: string[] = [];
  stderr = "";

  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  constructor(envOverrides: Record<string, string | undefined> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The server must be judged on what the client gives it, not on whatever
    // happens to be exported in the developer's shell.
    delete env.DATABASE_URL;
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }

    this.child = spawn("node", ["--import", "tsx", "src/mcp/main.ts"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    liveSessions.add(this);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.length === 0) continue;
      this.stdoutLines.push(line);

      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.stdoutPollution.push(line);
        continue;
      }
      if (message === null || typeof message !== "object" || message.jsonrpc !== "2.0") {
        this.stdoutPollution.push(line);
        continue;
      }
      if (typeof message.id === "number") {
        const resolve = this.pending.get(message.id);
        if (resolve) {
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    }
  }

  /** bytes sitting on stdout with no terminating newline — also pollution */
  get unterminatedStdout(): string {
    return this.buffer;
  }

  writeRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  notify(method: string, params: unknown = {}): void {
    this.writeRaw(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method} (id ${id})`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.writeRaw(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async initialize(): Promise<RpcMessage> {
    const response = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t10-blind-acceptance", version: "0" },
    });
    this.notify("notifications/initialized");
    return response;
  }

  callTool(name: string, args: unknown): Promise<RpcMessage> {
    return this.request("tools/call", { name, arguments: args });
  }

  describeOperation(operation: string): Promise<RpcMessage> {
    return this.callTool("describe_operation", { operation });
  }

  callOperation(operation: string, input?: unknown): Promise<RpcMessage> {
    return this.callTool("call_operation", input === undefined ? { operation } : { operation, input });
  }

  kill(): void {
    liveSessions.delete(this);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toolText(response: RpcMessage): string {
  const content = response.result?.content;
  expect(Array.isArray(content), `expected a content array, got ${JSON.stringify(response)}`).toBe(
    true,
  );
  return content?.[0]?.text ?? "";
}

/** tool bodies are documented as JSON text; protocol-layer failures are not */
function toolJson(response: RpcMessage): Record<string, any> {
  return JSON.parse(toolText(response)) as Record<string, any>;
}

function tryToolJson(response: RpcMessage): Record<string, any> | undefined {
  try {
    return JSON.parse(response.result?.content?.[0]?.text ?? "") as Record<string, any>;
  } catch {
    return undefined;
  }
}

function bar(periodStart: string, close: number, volume = 100_000, complete = true) {
  return { periodStart, close, volume, complete };
}

const ONE_BAR = [bar("2026-01-05T06:30:00.000Z", 10_000)];
const TWO_BARS = [bar("2026-01-05T06:30:00.000Z", 10_000), bar("2026-01-06T06:30:00.000Z", 10_000)];

function series(bars: unknown[], overrides: Record<string, unknown> = {}) {
  return { instrument: "instr:BLIND", venue: "KRX", currency: "KRW", bars, ...overrides };
}

function backtestInput(
  bars: unknown[],
  overrides: Record<string, unknown> = {},
  seriesOverrides: Record<string, unknown> = {},
) {
  return {
    series: series(bars, seriesOverrides),
    strategy: { name: "buy_and_hold" },
    cash: 1_000_000,
    ...overrides,
  };
}

/** smallest input that satisfies each operation's published required fields */
const MINIMAL_INPUT: Record<string, Record<string, unknown>> = {
  "strategy.list": {},
  "strategy.describe": { name: "sma_cross" },
  "backtest.run": backtestInput(ONE_BAR),
  "paper.account": {},
};

let session: McpSession;

beforeAll(async () => {
  session = new McpSession();
  await session.initialize();
}, 40_000);

afterAll(() => {
  for (const live of [...liveSessions]) live.kill();
});

// ---------------------------------------------------------------------------
// A — the surface itself
// ---------------------------------------------------------------------------

describe("S3 MCP surface shape (blind)", () => {
  it("A1. exposes exactly the three documented tools, with stable names", async () => {
    const response = await session.request("tools/list", {});
    const tools = (response.result?.tools ?? []) as { name: string }[];
    expect(tools.map((tool) => tool.name)).toEqual([...EXPECTED_TOOLS]);
  });

  it("A2. every tool publishes a usable object input schema", async () => {
    const response = await session.request("tools/list", {});
    const tools = (response.result?.tools ?? []) as {
      name: string;
      description?: string;
      inputSchema?: Record<string, any>;
    }[];

    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.inputSchema?.type, `${tool.name} schema is not an object`).toBe("object");
      expect(typeof tool.inputSchema?.properties).toBe("object");
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // The two tools that take an operation name must say so, or an agent has to guess.
    for (const name of ["describe_operation", "call_operation"]) {
      const schema = byName.get(name)?.inputSchema;
      expect(schema?.required, `${name} must require "operation"`).toContain("operation");
      expect(schema?.properties?.operation?.type).toBe("string");
    }
    expect(byName.get("call_operation")?.inputSchema?.properties?.input?.type).toBe("object");
  });

  it("A3. identifies itself as provenance over initialize", async () => {
    const probe = new McpSession();
    try {
      const response = await probe.initialize();
      expect(response.result?.serverInfo).toMatchObject({ name: "provenance" });
      expect(response.result?.capabilities).toHaveProperty("tools");
    } finally {
      probe.kill();
    }
  }, 40_000);
});

// ---------------------------------------------------------------------------
// B — one catalog, and it has no writes
// ---------------------------------------------------------------------------

describe("S3 catalog (blind)", () => {
  it("B1. list_operations returns the documented four operations with a kind each", async () => {
    const body = toolJson(await session.callTool("list_operations", {}));
    const operations = body.operations as { operation: string; kind: string; summary: string }[];
    expect(operations.map((entry) => entry.operation)).toEqual([...EXPECTED_OPERATIONS]);
    for (const entry of operations) {
      expect(entry.summary, `${entry.operation} has no summary`).toBeTruthy();
      // SKILL.md: "`write` 는 이 카탈로그에 존재하지 않는다."
      expect(["read", "compute"], `${entry.operation} kind`).toContain(entry.kind);
    }
  });

  it("B2. the money-creating command (paper open) is unreachable from MCP", async () => {
    const response = await session.callOperation("paper.open", { seed: 1_000_000, currency: "KRW" });
    expect(response.result?.isError).toBe(true);
    expect(toolJson(response).error).toBe("unknown_operation");

    const described = await session.describeOperation("paper.open");
    expect(described.result?.isError).toBe(true);
    expect(toolJson(described)).toMatchObject({
      error: "unknown_operation",
      known: [...EXPECTED_OPERATIONS],
    });
  });

  it("B3. no arbitrary-module escape: extra module keys never execute a file", async () => {
    const modulePath = "tests/fixtures/t8/buy-once.strategy.ts";
    const probe = new McpSession({ BACKTEST_STRATEGY_MODULE_ENABLED: "true" });
    try {
      await probe.initialize();
      // Every smuggling shape at once: sibling key, nested key, and a path as a name.
      const smuggled = await probe.callOperation("backtest.run", {
        ...backtestInput(TWO_BARS, {
          strategy: { name: "buy_and_hold", module: modulePath },
          strategyModule: modulePath,
          module: modulePath,
        }),
      });
      const body = toolJson(smuggled);
      expect(smuggled.result?.isError).toBeUndefined();
      // The named built-in ran; the smuggled path was not honoured.
      expect(body.strategy.name).toBe("buy_and_hold");
      expect(JSON.stringify(body)).not.toContain(modulePath);

      const asName = await probe.callOperation("backtest.run", {
        ...backtestInput(ONE_BAR, { strategy: { name: modulePath } }),
      });
      expect(asName.result?.isError).toBe(true);
      expect(toolJson(asName).error).toBe("unknown_strategy");
    } finally {
      probe.kill();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// C — the outcome boundary the slice claims (domain refusal ≠ protocol error)
// ---------------------------------------------------------------------------

describe("S3 outcome boundary (blind)", () => {
  const domainRefusals: [string, Record<string, unknown>, string][] = [
    ["empty series", backtestInput([]), "empty_series"],
    [
      "incomplete bar",
      backtestInput([bar("2026-01-05T06:30:00.000Z", 10_000, 100_000, false)]),
      "incomplete_bar",
    ],
    [
      "non-monotonic bars",
      backtestInput([bar("2026-01-06T06:30:00.000Z", 10_000), bar("2026-01-05T06:30:00.000Z", 10_000)]),
      "non_monotonic_series",
    ],
    [
      "total_return price basis",
      backtestInput(ONE_BAR, {}, { priceBasis: "total_return" }),
      "unsupported_price_basis",
    ],
  ];

  it.each(domainRefusals)(
    "C1. %s is a SUCCESSFUL call carrying a refusal, never an isError",
    async (_label, input, reason) => {
      const response = await session.callOperation("backtest.run", input);
      // "isError 가 없으면 호출은 성공한 것" — a domain refusal must not be flattened up.
      expect(response.result?.isError).toBeUndefined();
      const body = toolJson(response);
      expect(body.outcome).toMatchObject({ status: "refused", reason });
      expect(body.error).toBeUndefined();
    },
    30_000,
  );

  const callErrors: [string, string, Record<string, unknown>, string][] = [
    ["schema violation", "backtest.run", backtestInput(ONE_BAR, { cash: -5 }), "invalid_input"],
    [
      "unknown strategy",
      "backtest.run",
      backtestInput(ONE_BAR, { strategy: { name: "no_such" } }),
      "unknown_strategy",
    ],
    [
      "cross-field rule fast >= slow",
      "backtest.run",
      backtestInput(ONE_BAR, { strategy: { name: "sma_cross", params: { fast: 20, slow: 5 } } }),
      "invalid_params",
    ],
    ["unknown strategy name", "strategy.describe", { name: "no_such" }, "unknown_strategy"],
  ];

  it.each(callErrors)(
    "C2. %s is a call refusal (isError) and carries no outcome to mistake for an answer",
    async (_label, operation, input, code) => {
      const response = await session.callOperation(operation, input);
      expect(response.result?.isError).toBe(true);
      const body = toolJson(response);
      expect(body.error).toBe(code);
      expect(body.message, "a call refusal must say what to fix").toBeTruthy();
      expect(body.outcome).toBeUndefined();
    },
    30_000,
  );

  it("C3. an uncomputable metric stays a reason, never 0 or null", async () => {
    const response = await session.callOperation(
      "backtest.run",
      backtestInput(TWO_BARS, { strategy: { name: "buy_and_hold" } }),
    );
    expect(response.result?.isError).toBeUndefined();
    const outcome = toolJson(response).outcome;
    expect(outcome.status).toBe("complete");
    // No sells happened, so a win rate is undefined — not zero.
    expect(outcome.performance.winRate).toEqual({ status: "unavailable", reason: "no_sells" });
    // Accuracy self-disclosure travels with the numbers (golden rule 4).
    expect(outcome.mode).toBeTruthy();
    expect(outcome.costModel).toBeTruthy();
    expect(outcome.priceBasis).toBeTruthy();
  }, 30_000);

  it("C4. fillCount 0 is reported with the open orders and the cash they tie up", async () => {
    // Gap up on the second bar: a market order priced off bar 1 cannot be filled at bar 2.
    const response = await session.callOperation(
      "backtest.run",
      backtestInput([
        bar("2026-01-05T06:30:00.000Z", 10_000),
        bar("2026-01-06T06:30:00.000Z", 40_000),
      ]),
    );
    expect(response.result?.isError).toBeUndefined();
    const outcome = toolJson(response).outcome;
    expect(outcome.status).toBe("complete");
    expect(outcome.fillCount).toBe(0);
    // Golden rule 3: the evidence that this is "bought nothing", not "earned nothing".
    expect(outcome.orders.length).toBeGreaterThan(0);
    expect(outcome.cash[0].reserved).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// D — does describe_operation publish a schema call_operation honours?
// ---------------------------------------------------------------------------

describe("S3 published schema vs runtime (blind)", () => {
  it("D1. describe_operation returns an input schema for every listed operation", async () => {
    for (const operation of EXPECTED_OPERATIONS) {
      const body = toolJson(await session.describeOperation(operation));
      expect(body.operation).toBe(operation);
      expect(body.kind, `${operation} kind`).toBeTruthy();
      expect(body.input?.type, `${operation} input schema`).toBe("object");
    }
  }, 30_000);

  it("D2. every field the schema marks required is actually required at runtime", async () => {
    const described = toolJson(await session.describeOperation("backtest.run"));
    const required = described.input.required as string[];
    expect(required.sort()).toEqual(["cash", "series", "strategy"]);

    for (const field of required) {
      const input = { ...backtestInput(ONE_BAR) } as Record<string, unknown>;
      delete input[field];
      const response = await session.callOperation("backtest.run", input);
      expect(response.result?.isError, `omitting ${field} must be rejected`).toBe(true);
      expect(toolJson(response).error).toBe("invalid_input");
    }
  }, 30_000);

  it("D3. every schema that publishes additionalProperties:false enforces it", async () => {
    const violations: string[] = [];
    for (const operation of EXPECTED_OPERATIONS) {
      const described = toolJson(await session.describeOperation(operation));
      if (described.input?.additionalProperties !== false) continue;

      const response = await session.callOperation(operation, {
        ...MINIMAL_INPUT[operation],
        blindUnknownKey: 1,
      });
      const body = tryToolJson(response);
      if (response.result?.isError !== true || body?.error !== "invalid_input") {
        violations.push(
          `${operation}: schema says additionalProperties:false but an unknown key produced ` +
            `isError=${String(response.result?.isError)} error=${String(body?.error ?? "(none)")}`,
        );
      }
    }
    expect(violations).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// E — stdout purity and survival
// ---------------------------------------------------------------------------

describe("S3 stdout purity and robustness (blind)", () => {
  it("E1. garbage on stdin does not kill the server and does not reach stdout", async () => {
    session.writeRaw("{ this is not json at all");
    session.writeRaw("");
    session.writeRaw("<html>not even close</html>");
    session.writeRaw(JSON.stringify({ jsonrpc: "2.0", id: 999_001, method: "no/such/method" }));

    const after = toolJson(await session.callTool("list_operations", {}));
    expect(after.operations).toHaveLength(EXPECTED_OPERATIONS.length);
    expect(session.stdoutPollution).toEqual([]);
    expect(session.child.exitCode).toBeNull();
  }, 30_000);

  it("E2. an unknown JSON-RPC method answers with a protocol error, not a crash", async () => {
    const response = await session.request("no/such/method", {});
    expect(response.error?.code).toBe(-32601);
    expect(response.result).toBeUndefined();
    expect(session.child.exitCode).toBeNull();
  }, 30_000);

  it("E3. an unknown tool and malformed tool params come back as tool errors", async () => {
    const unknownTool = await session.callTool("definitely_not_a_tool", {});
    expect(unknownTool.result?.isError).toBe(true);

    const missingRequired = await session.callTool("call_operation", {});
    expect(missingRequired.result?.isError).toBe(true);

    const wrongType = await session.callTool("describe_operation", { operation: 12_345 });
    expect(wrongType.result?.isError).toBe(true);

    // ...and the session is still usable afterwards.
    expect(toolJson(await session.callTool("list_operations", {})).operations).toHaveLength(4);
  }, 30_000);

  it("E4. a response far larger than a pipe buffer arrives as one intact frame", async () => {
    const start = Date.parse("2026-01-05T06:30:00.000Z");
    const bars = Array.from({ length: 4000 }, (_unused, index) =>
      bar(new Date(start + index * 86_400_000).toISOString(), 10_000 + (index % 97), 1_000_000),
    );
    const before = session.stdoutLines.length;
    const response = await session.callOperation(
      "backtest.run",
      backtestInput(bars, {
        strategy: { name: "sma_cross", params: { fast: 5, slow: 20 } },
        cash: 100_000_000,
      }),
    );
    const outcome = toolJson(response).outcome;
    expect(outcome.status).toBe("complete");
    expect(outcome.barCount).toBe(4000);

    const written = session.stdoutLines.slice(before);
    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBeGreaterThan(64 * 1024);
    expect(session.stdoutPollution).toEqual([]);
  }, 90_000);

  it("E5. the whole session left nothing non-protocol on stdout", () => {
    expect(session.stdoutPollution).toEqual([]);
    expect(session.unterminatedStdout).toBe("");
    expect(session.stdoutLines.length).toBeGreaterThan(0);
    // The readiness banner belongs on stderr, where it cannot break framing.
    expect(session.stderr).toContain("ready");
    expect(session.stdoutLines.join("\n")).not.toContain("ready on stdio");
  });

  it("E6. the server exits cleanly when the client closes stdin (no zombie)", async () => {
    const probe = new McpSession();
    try {
      await probe.initialize();
      const exit = new Promise<number | null>((resolve) => {
        probe.child.once("exit", (code) => resolve(code));
      });
      probe.child.stdin.end();
      const code = await Promise.race([
        exit,
        new Promise<"still-running">((resolve) => setTimeout(() => resolve("still-running"), 10_000)),
      ]);
      expect(code).toBe(0);
    } finally {
      probe.kill();
    }
  }, 40_000);
});

// ---------------------------------------------------------------------------
// F — environment: with and without DATABASE_URL
// ---------------------------------------------------------------------------

describe("S3 database configuration boundary (blind)", () => {
  it("F1. without DATABASE_URL the server still starts and only paper.account is blocked", async () => {
    const strategies = toolJson(await session.callOperation("strategy.list", {}));
    expect(strategies.strategies.map((entry: { name: string }) => entry.name)).toEqual([
      "buy_and_hold",
      "sma_cross",
    ]);

    const account = await session.callOperation("paper.account", {});
    expect(account.result?.isError).toBe(true);
    expect(toolJson(account).error).toBe("configuration_required");
  }, 30_000);

  it("F2. an unreachable DATABASE_URL is `unavailable`, not `configuration_required`", async () => {
    const password = "blindProbePassword123";
    const probe = new McpSession({
      DATABASE_URL: `postgresql://blindprobeuser:${password}@127.0.0.1:59999/blindprobedb`,
    });
    try {
      await probe.initialize();
      const account = await probe.callOperation("paper.account", {});
      expect(account.result?.isError).toBe(true);
      const body = toolJson(account);
      // SKILL.md: the two must not be merged — the next move is opposite.
      expect(body.error).toBe("unavailable");
      expect(body.error).not.toBe("configuration_required");

      // The connection string must not leak through the failure path.
      const everything = `${JSON.stringify(body)}\n${probe.stderr}\n${probe.stdoutLines.join("\n")}`;
      expect(everything).not.toContain(password);
      expect(everything).not.toContain("blindprobeuser");
      expect(everything).not.toContain("blindprobedb");

      // Non-durable operations are unaffected by a broken database.
      const strategies = await probe.callOperation("strategy.list", {});
      expect(strategies.result?.isError).toBeUndefined();
      expect(toolJson(strategies).strategies).toHaveLength(2);
    } finally {
      probe.kill();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// G — protocol interop
// ---------------------------------------------------------------------------

describe("S3 protocol interop (blind)", () => {
  it("G1. a zero-input tool is callable with params.arguments omitted", async () => {
    // MCP CallToolRequest declares `arguments` optional (see the SDK's
    // CallToolRequestParamsSchema), and list_operations publishes an input
    // schema with no required properties, so a conforming client is entitled
    // to send `{"name":"list_operations"}` with no arguments at all.
    const response = await session.request("tools/call", { name: "list_operations" });
    expect(response.result?.isError).not.toBe(true);
    expect(toolJson(response).operations).toHaveLength(EXPECTED_OPERATIONS.length);
  }, 30_000);

  it("G2. concurrent requests are answered on the right ids", async () => {
    const [list, describe_, run] = await Promise.all([
      session.callTool("list_operations", {}),
      session.describeOperation("strategy.describe"),
      session.callOperation("strategy.list", {}),
    ]);
    expect(toolJson(list).operations).toHaveLength(4);
    expect(toolJson(describe_).operation).toBe("strategy.describe");
    expect(toolJson(run).strategies).toHaveLength(2);
    expect(session.stdoutPollution).toEqual([]);
  }, 30_000);
});

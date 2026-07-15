import { createServer, type ServerResponse } from "node:http";

import { bootstrapComposition } from "../composition";
import { checkRuntimeDependencies, closeRuntimeDependencies } from "../platform/runtime/dependencies";

function respond(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function start(): Promise<void> {
  bootstrapComposition();
  const initialReadiness = await checkRuntimeDependencies();
  if (initialReadiness.status !== "ready") throw new Error("worker dependencies are not ready");

  const port = Number.parseInt(process.env.WORKER_HEALTH_PORT ?? "3001", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("WORKER_HEALTH_PORT must be an integer from 1 to 65535");
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") return respond(response, 405, { status: "method_not_allowed" });
    if (request.url === "/health") return respond(response, 200, { service: "worker", status: "ok" });
    if (request.url === "/ready") {
      const readiness = await checkRuntimeDependencies();
      return respond(response, readiness.status === "ready" ? 200 : 503, { ...readiness, service: "worker" });
    }
    return respond(response, 404, { status: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });

  const stop = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeRuntimeDependencies();
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup failure";
  process.stderr.write(`worker startup failed: ${message}\n`);
  process.exitCode = 1;
});

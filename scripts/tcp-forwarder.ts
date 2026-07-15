import { once } from "node:events";
import { createConnection, createServer, type Server } from "node:net";
import { pathToFileURL } from "node:url";

interface TcpForwarderOptions {
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredPort(environment: NodeJS.ProcessEnv, name: string): number {
  const value = Number(requiredEnvironment(environment, name));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a TCP port`);
  return value;
}

export function createTcpForwarder(options: TcpForwarderOptions): Server {
  return createServer((downstream) => {
    const upstream = createConnection({ host: options.targetHost, port: options.targetPort });
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.once("close", () => upstream.destroy());
    upstream.once("close", () => downstream.destroy());
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
}

async function main(environment: NodeJS.ProcessEnv): Promise<void> {
  const options: TcpForwarderOptions = {
    listenHost: environment.FORWARD_LISTEN_HOST?.trim() || "0.0.0.0",
    listenPort: requiredPort(environment, "FORWARD_LISTEN_PORT"),
    targetHost: requiredEnvironment(environment, "FORWARD_TARGET_HOST"),
    targetPort: requiredPort(environment, "FORWARD_TARGET_PORT"),
  };
  const server = createTcpForwarder(options);
  server.listen(options.listenPort, options.listenHost);
  await once(server, "listening");
  process.stdout.write(`forwarding ${options.listenHost}:${options.listenPort} to ${options.targetHost}:${options.targetPort}\n`);

  const shutdown = (): void => {
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await once(server, "close");
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main(process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "TCP forwarder failed"}\n`);
    process.exitCode = 1;
  });
}

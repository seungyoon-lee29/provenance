import "server-only";
import { request as httpsRequest } from "node:https";

import type { TransportExecutor } from "./types";

export function createPinnedHttpsTransportExecutor(): TransportExecutor {
  return (input) => new Promise<unknown>((resolve, reject) => {
    const address = input.resolvedAddresses[0];
    if (address === undefined) return reject(new Error("provider transport failed"));
    const target = new URL(input.url);
    let settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(new Error("provider transport failed"));
      }
    };
    const request = httpsRequest({
      protocol: "https:",
      host: address,
      port: 443,
      servername: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: input.method,
      headers: { ...input.headers, host: target.host },
      rejectUnauthorized: true,
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        fail();
        return;
      }
      const declaredLength = Number.parseInt(response.headers["content-length"] ?? "0", 10);
      if (Number.isFinite(declaredLength) && declaredLength > input.maxResponseBytes) {
        response.destroy();
        fail();
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > input.maxResponseBytes) {
          response.destroy();
          fail();
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          settled = true;
          resolve(parsed);
        } catch {
          fail();
        }
      });
    });
    request.once("error", fail);
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("provider transport timeout")));
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

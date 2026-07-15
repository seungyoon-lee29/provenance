import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("node:https", () => ({ request: requestMock }));

import { createPinnedHttpsTransportExecutor } from "../src/platform/provider-transport/https-executor";

beforeEach(() => requestMock.mockReset());

function fakeRequest(responseStatus: number, body: Buffer, headers: IncomingMessage["headers"] = {}) {
  let responseCallback: ((response: IncomingMessage) => void) | undefined;
  const request = new EventEmitter() as unknown as ClientRequest;
  request.setTimeout = vi.fn();
  request.write = vi.fn(() => request) as unknown as ClientRequest["write"];
  request.end = vi.fn(() => {
    const response = new EventEmitter() as unknown as IncomingMessage;
    Object.assign(response, { statusCode: responseStatus, headers, resume: vi.fn(), destroy: vi.fn() });
    responseCallback?.(response);
    if (responseStatus >= 200 && responseStatus < 300) {
      response.emit("data", body);
      response.emit("end");
    }
    return request;
  }) as unknown as ClientRequest["end"];
  requestMock.mockImplementationOnce((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    responseCallback = callback;
    return request;
  });
  return request;
}

function input(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    url: "https://api.provider.example/v1/quote",
    method: "POST" as const,
    headers: { authorization: "Bearer sentinel", "content-type": "application/json" },
    body: JSON.stringify({ symbol: "AAPL" }),
    redirect: "error" as const,
    maxResponseBytes: 1_024,
    resolvedAddresses: ["8.8.8.8"],
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("pinned HTTPS executor", () => {
  it("connects to the vetted IP while preserving TLS SNI and Host", async () => {
    fakeRequest(200, Buffer.from(JSON.stringify({ price: 101 })));
    await expect(createPinnedHttpsTransportExecutor()(input())).resolves.toEqual({ price: 101 });
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      host: "8.8.8.8",
      servername: "api.provider.example",
      path: "/v1/quote",
      headers: expect.objectContaining({ host: "api.provider.example" }),
    }), expect.any(Function));
  });

  it("does not follow redirects", async () => {
    const request = fakeRequest(302, Buffer.alloc(0), { location: "https://attacker.example/secret" });
    await expect(createPinnedHttpsTransportExecutor()(input())).rejects.toThrow("provider transport failed");
    expect(request.end).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it("rejects declared and streamed responses over the registered limit", async () => {
    fakeRequest(200, Buffer.alloc(0), { "content-length": "2048" });
    await expect(createPinnedHttpsTransportExecutor()(input())).rejects.toThrow("provider transport failed");
    fakeRequest(200, Buffer.alloc(2_048));
    await expect(createPinnedHttpsTransportExecutor()(input())).rejects.toThrow("provider transport failed");
  });
});

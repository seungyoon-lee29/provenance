import { once } from "node:events";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";

import { describe, expect, it } from "vitest";

import { createTcpForwarder } from "../scripts/tcp-forwarder";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

describe("local TCP ingress forwarder", () => {
  it("forwards bytes to only the configured target", async () => {
    const target = createServer((socket) => socket.pipe(socket));
    const targetPort = await listen(target);
    const forwarder = createTcpForwarder({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort,
    });
    const forwardPort = await listen(forwarder);
    const client = createConnection({ host: "127.0.0.1", port: forwardPort });

    try {
      await once(client, "connect");
      client.write("foundation-ready");
      const [data] = await once(client, "data");
      expect(data.toString()).toBe("foundation-ready");
    } finally {
      client.destroy();
      await close(forwarder);
      await close(target);
    }
  });
});

export function createNetworkHarness(allowedOrigins: readonly string[]) {
  const allowlist = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  return {
    assertAllowed(target: string): URL {
      const url = new URL(target);
      if (!allowlist.has(url.origin)) throw new Error(`network harness denied origin: ${url.origin}`);
      return url;
    },
  };
}

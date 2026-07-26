import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_DATABASE_URL } from "../src/platform/runtime/defaults";

/**
 * The host-reachable database endpoint is ONE fact written in three places:
 * `DEFAULT_DATABASE_URL`, `.env.example`, and the compose port publishing. Those
 * three drifting apart is not hypothetical — it is the state this repo shipped
 * in. `compose.yaml` published no host port at all while both the default URL
 * and `.env.example` pointed at `127.0.0.1:5432`, so the documented setup
 * (`compose:up` → `db:migrate`) died with ECONNREFUSED while `docker ps` showed
 * postgres healthy, and the CLI's durable commands answered exit 2 with advice
 * ("check postgres is running") that was already satisfied. Nothing caught it
 * because every individual file was self-consistent.
 *
 * This is a static agreement check: it needs no docker and asserts only that the
 * three declarations name the same host and port. It cannot prove a database is
 * actually reachable — that is the compose lane's job — but it does stop the
 * three from silently disagreeing again.
 */

const ROOT = resolve(import.meta.dirname, "..");

/** `postgres-ingress`'s published port, e.g. `127.0.0.1:${POSTGRES_HOST_PORT:-5432}:5432`. */
function composeHostEndpoint(): Readonly<{ host: string; port: string }> {
  const compose = readFileSync(resolve(ROOT, "compose.yaml"), "utf8");
  const service = compose.slice(compose.indexOf("postgres-ingress:"));
  const published = /-\s*"(?<host>[\d.]+):\$\{POSTGRES_HOST_PORT:-(?<port>\d+)\}:\d+"/u.exec(service);
  if (published?.groups === undefined) throw new Error("postgres-ingress publishes no host port");
  return { host: published.groups.host!, port: published.groups.port! };
}

describe("host database endpoint", () => {
  it("compose, the CLI default and .env.example name the same host and port", () => {
    const compose = composeHostEndpoint();
    const fromDefault = new URL(DEFAULT_DATABASE_URL);
    expect({ host: fromDefault.hostname, port: fromDefault.port }).toEqual(compose);

    const example = /^DATABASE_URL=(?<url>.+)$/mu.exec(readFileSync(resolve(ROOT, ".env.example"), "utf8"));
    if (example?.groups === undefined) throw new Error(".env.example declares no DATABASE_URL");
    const fromExample = new URL(example.groups.url!.trim());
    expect({ host: fromExample.hostname, port: fromExample.port }).toEqual(compose);
  });

  it("the ingress binds loopback only — the database is never published to every interface", () => {
    // `postgres` itself publishes nothing; the ingress is the single host door,
    // and it must stay on 127.0.0.1. A `0.0.0.0` bind would put a
    // password-known database on every interface the machine has.
    expect(composeHostEndpoint().host).toBe("127.0.0.1");
  });
});

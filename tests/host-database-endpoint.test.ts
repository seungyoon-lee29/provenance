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

/**
 * `.dockerignore` excludes `.env*` — deliberately, and the glob is wide on
 * purpose: `.env.example` names 36 credential variables (`KIS_APP_SECRET`,
 * `GOOGLE_IDENTITY_CLIENT_SECRET`, …) and that pattern is what keeps the whole
 * family out of a runtime image. Poking a hole in it to satisfy a test would
 * trade a security floor for convenience.
 *
 * So the container lane genuinely cannot read the file, and the reduction is
 * DECLARED rather than skipped in silence — the same contract `.git` already
 * has (`RELEASE_LANE_WITHOUT_GIT`, tests/release/git-lane.ts). Anywhere else a
 * missing `.env.example` is a broken checkout and this throws.
 *
 * Nothing is lost: the host lane (`npm run check`) reads the real file, and the
 * compose↔default half of the agreement still runs in both lanes.
 */
function envExampleDatabaseUrl(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(resolve(ROOT, ".env.example"), "utf8");
  } catch {
    if (process.env.CONFIG_LANE_WITHOUT_ENV_EXAMPLE === "1") return undefined;
    throw new Error(
      "this check reads .env.example and this environment has none. If that is "
      + "expected — e.g. an image built with .env* excluded — declare it with "
      + "CONFIG_LANE_WITHOUT_ENV_EXAMPLE=1 so the reduced coverage is visible, "
      + "instead of skipping silently.",
    );
  }
  const example = /^DATABASE_URL=(?<url>.+)$/mu.exec(raw);
  if (example?.groups === undefined) throw new Error(".env.example declares no DATABASE_URL");
  return example.groups.url!.trim();
}

describe("host database endpoint", () => {
  it("compose, the CLI default and .env.example name the same host and port", () => {
    const compose = composeHostEndpoint();
    const fromDefault = new URL(DEFAULT_DATABASE_URL);
    expect({ host: fromDefault.hostname, port: fromDefault.port }).toEqual(compose);

    const declared = envExampleDatabaseUrl();
    if (declared === undefined) return; // 선언된 축소 — 위 두 선언의 일치는 이미 확인했다.
    const fromExample = new URL(declared);
    expect({ host: fromExample.hostname, port: fromExample.port }).toEqual(compose);
  });

  it("the ingress binds loopback only — the database is never published to every interface", () => {
    // `postgres` itself publishes nothing; the ingress is the single host door,
    // and it must stay on 127.0.0.1. A `0.0.0.0` bind would put a
    // password-known database on every interface the machine has.
    expect(composeHostEndpoint().host).toBe("127.0.0.1");
  });
});

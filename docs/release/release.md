# Release process

This is the F11 release gate. It composes the finished F0–F10 module seams as a
black box and produces the shippable artifacts. The **scripted, network-off**
provider lane is the release performance and correctness canon
([rights.md](./rights.md)); real-provider contracts are opt-in evidence.

## Gate matrix

| Gate | Command | State |
| --- | --- | --- |
| typecheck / lint / unit / seam | `npm run check` | automated |
| release allowlist + SHA-256 + secret-free zip | `npm run package:release` + `tests/release/` | automated |
| markdown links + stale-contract | `npm run check:release-docs` | automated |
| browser flows (desktop + mobile) | `npm run test:browser` | automated (needs app) |
| performance p95 (§11.2) | `npm run test:performance` | automated (needs app) |
| synthetic screenshots | `tests/browser/*.spec.ts` | automated (needs app) |
| production stack drill (compose up, migrate/rollback, health) | `npm run compose:verify` | **ready-for-human** (Docker daemon) |
| backup / restore / deletion-suppression drill | see [backup.md](./backup.md) | **ready-for-human** (Docker daemon) |
| §11.3 5-minute stress / load | — | **ready-for-human** (load tool not vendored) |
| two guest **public** screenshots | real public-data contract | **ready-for-human** (USD 0 budget, providers on hold) |

## Release ZIP

```
npm run package:release
```

Builds `dist/release/provenance-release.zip` and `manifest.json`
([`scripts/package-release.ts`](../../scripts/package-release.ts)). The manifest
lists every shipped file with its SHA-256 and category. Packaging **fails
closed** if a tracked file fits no allowed category, if a credential pattern is
found, or if a forbidden path (`.scratch/`, `.env*` except `.env.example`,
`.secrets/`, `.git/`, build/cache) would ship. `tests/release/release-zip.test.ts`
unpacks the archive into a clean directory and asserts it equals the manifest.

The unpack → documented command → **healthcheck** step needs the Docker stack
and is part of the production-stack drill above.

## Screenshots

Four scenes with a provenance/rights manifest
(`tests/release/screenshot-manifest.json`):

| File | Scene | Provenance |
| --- | --- | --- |
| `explicit-unavailable.png` | value-free unavailable outcome | synthetic |
| `paper-workspace.png` | paper trading workspace | synthetic |
| `guest-desktop-public.png` | logged-out desktop public quote | real public data (ready-for-human) |
| `guest-mobile-public.png` | logged-out mobile public quote | real public data (ready-for-human) |

Synthetic screens exclude secrets and personal account detail by construction.
The two public screenshots are gated on an allowed real public-data contract.

## Ready-for-human gates

The four gates marked above cannot be closed in the scripted sandbox. To
finish the release, an operator with a Docker daemon and (for the public
screenshots) an allowed public-data source runs the compose drill, the
backup/restore drill, a load run, and captures the two public screenshots,
then records the results against this matrix.

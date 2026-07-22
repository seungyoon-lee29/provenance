# Data rights and provider scope

The current external-data budget is **USD 0**. No paid provider contract and no
display/redistribution agreement is active. The app ships on **scripted,
network-off data** and only calls a real provider when a single-owner operator
explicitly opts in.

## License Scope

Every Market Observation carries a `LicenseScope` (audience, purposes, validity)
alongside its provenance and as-of time. Values allowed for public display are
served without login; everything else renders an Information Outcome instead of
a fabricated number.

| Audience | Meaning |
| --- | --- |
| `public` | allowed for logged-out public display |
| `personal` | single-owner personal use only, never redistributed |
| `internal_test_only` | synthetic / scripted, never presented as real |

## Providers

Provider policy is configured in [`.env.example`](../../.env.example). All keys
are empty and every `RUN_*_CONTRACT` flag defaults to `false`.

| Provider | Scope | Default |
| --- | --- | --- |
| KIS Open API | `free_personal` quotes/chart/account/paper | opt-in contract only |
| Gemini | AI over allowed materials | opt-in, key required |
| DART / KRX | public filings / EOD | opt-in, key required |
| US Treasury yield curve | public domain (17 U.S.C. §105), keyless daily XML, guest-redistributable | opt-in via `PUBLIC_MARKET_ENABLED` |
| ECB reference FX (USD/KRW cross) | redistributable with attribution, keyless daily CSV; cross is derived → shown as `indicative` | opt-in via `PUBLIC_MARKET_ENABLED` |

No personal key is ever redistributed to a logged-out public feed or another
user's cache. See [`docs/configuration/provider-credentials.md`](../configuration/provider-credentials.md)
and [`docs/research/provider-options.md`](../research/provider-options.md).

## Screenshots

Release screenshots carry a provenance/rights manifest
(`tests/release/screenshot-manifest.json`). Synthetic screens are labelled
`internal_test_only`; the two guest **public** screenshots require an allowed
real public-data contract and are a ready-for-human evidence gate (see
[release.md](./release.md)).

// Intentionally empty — a NO-OP under plain Node (CLI, MCP, worker, tsx, vitest).
//
// Why this is vendored instead of `npm install server-only`:
// the real package's index.js THROWS ("This module cannot be imported from a Client
// Component module"); only its `react-server` export condition resolves to an empty file.
// Plain Node does not set that condition, so installing the real package makes every
// `import "server-only"` module crash the CLI. Measured 2026-07-26:
//   npx tsx src/cli/main.ts paper account  ->  exit 1, throw from server-only/index.js
// The `--conditions=react-server` workaround was rejected: it would have to ride every
// Node entry point AND the MCP stdio argv that SKILL.md documents and a drift test pins.
//
// Next does NOT read this file. It aliases the bare `server-only` specifier per layer
// (server -> empty, client -> a throwing module) inside its own compiler, so enforcement
// is unaffected by what lives here. Verified under Next 16.2.10 Turbopack, 2026-07-26:
// a marked module imported into a "use client" file still fails `next build` with
// "You're importing a module that depends on \"server-only\"".
//
// DO NOT replace this with the real `server-only` package — that is exactly the change
// that breaks the CLI, and the failure surfaces as a confusing React error.

import { main } from "./server";

/**
 * T10 S3 — MCP stdio entry point. Registered in an agent client's config as
 * the command to spawn; see the SKILL.md onboarding block.
 *
 * A crash must not leave a half-spoken JSON-RPC stream: report to stderr and
 * exit non-zero so the client sees the process die instead of hanging on a
 * response that will never come.
 */
main().catch((error: unknown) => {
  process.stderr.write(`provenance MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

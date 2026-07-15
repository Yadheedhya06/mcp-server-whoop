# Contributing

Thanks for contributing to mcp-server-whoop.

## Development

1. Fork and clone the repository.
2. Install dependencies with `npm ci`.
3. Make a focused change without adding credentials or real WHOOP data.
4. Add or update synthetic tests.
5. Run `npm run check` and `npm audit --omit=dev`.
6. Open a pull request describing behavior and security impact.

## Rules

- Never commit real OAuth client secrets, access tokens, refresh tokens, WHOOP record IDs, or identifiable health data.
- Preserve read-only WHOOP behavior unless a separate, explicitly reviewed design is proposed.
- Keep stdio stdout reserved for MCP protocol messages; diagnostics belong on stderr.
- Treat pending WHOOP data as unfinished and do not substitute stale recovery values.
- Use each record's own timezone offset for local-time conversion.

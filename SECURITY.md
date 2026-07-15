# Security policy

## Supported versions

Security fixes are provided for the latest published version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed credential. Use GitHub's private vulnerability reporting for this repository:

<https://github.com/Yadheedhya06/mcp-server-whoop/security/advisories/new>

Include the affected version, reproduction steps, impact, and any suggested fix. Please do not include real WHOOP tokens or health records. You should receive an acknowledgement within 72 hours.

## Design boundary

- Standard MCP over local stdio. No hosted health-data relay or project-operated backend.
- Only documented WHOOP OAuth and Developer API origins are used.
- OAuth scopes are limited to `offline` and documented read scopes.
- The five health-data tools are read-only, non-destructive, and idempotent. Their open-world access is constrained to WHOOP's API.
- No WHOOP mutation, generic HTTP, shell, filesystem, raw SQL, or raw API passthrough tool.
- No telemetry, analytics, or health-record cache.
- Credentials are excluded from MCP tool inputs and outputs.
- On Linux and macOS, local token rotation uses a PID-independent heartbeat lease and atomic persistence. Every credential-path ancestor is checked; the direct parent is current-user-owned `0700`, and the credential file is a single-link current-user-owned `0600` regular file.
- Credential-path symlinks, unsafe ancestors, multiple hard links, and file swaps between path validation and open are rejected. Native Windows credential persistence fails closed; only a short-lived access token supplied through the process environment is supported there.
- Requests have bounded timeouts and bounded authentication/rate-limit retries.
- WHOOP response bodies are not reflected in AI-visible errors.

## Verification

See [SECURITY-EVIDENCE.md](SECURITY-EVIDENCE.md) for the threat boundary, reproducible commands, test invariants, independent scanners, SBOM, and release-provenance design.

This project has not undergone a paid independent penetration test. Automated scanners and tests are evidence, not a guarantee or security certification.

# Changelog

All notable changes to this project will be documented here.

## 0.2.1 - 2026-07-16

### Security

- Fails closed for persistent credentials on native Windows instead of treating POSIX file modes as Windows ACL protection; short-lived environment access tokens remain supported.
- Rejects symlinks and unsafe ownership or write permissions across the full credential ancestor chain on supported POSIX systems.
- Replaces PID-liveness locks with heartbeat leases, preventing PID reuse from indefinitely blocking token refresh and preventing an owner from deleting a replaced lock.
- Clean-builds `dist`, removes source maps from the package, audits compiled JavaScript and the exact packed runtime, and verifies that packed runtime files are byte-identical to the audited build.
- Pins installation examples to an exact package version by default and documents Windows and plaintext-storage limitations precisely.
- Adds native Windows and macOS security CI coverage.

## 0.2.0 - 2026-07-15

### Security hardening

- Added a reproducible 210-check package/source audit and expanded the behavioral suite to 26 tests.
- Added CodeQL, Gitleaks, dependency review, OpenSSF Scorecard, CycloneDX SBOM, signature verification, and SHA-pinned CI workflows.
- Added an npm trusted-publishing workflow with Sigstore provenance plus a GitHub SBOM attestation bound to the exact npm tarball, without a long-lived npm token.
- Hardened OAuth with 256-bit generated state, constant-time state checks, strict loopback callback validation, bounded token responses, and no-cache callback responses.
- Rejects symlinked, multiply linked, wrong-owner, oversized, structurally invalid, or broadly exposed credential storage; uses exclusive temporary files, crash-aware locking, atomic replacement, file and directory syncing, and `0600` file permissions.
- Bounds WHOOP responses, validates records and pagination tokens, detects pagination cycles, sanitizes labels and numeric health signals, and discards impossible values.
- Prevents WHOOP API and OAuth error response bodies from reaching MCP clients.
- Validates every record timestamp and timezone offset before local timestamp conversion.
- Loads the MCP server and registry versions from synchronized package metadata to avoid version drift.

### Documentation

- Added a public threat model, security evidence guide, and a clear minimum-authority rationale for the five-tool design.

## 0.1.1 - 2026-07-15

- Added package ownership metadata and `server.json` for the official MCP Registry.

## 0.1.0 - 2026-07-15

- Initial public release.
- Added local WHOOP OAuth onboarding and secure rotating-token persistence.
- Added five read-only MCP tools for overview, recovery, sleep, cycle strain, and workouts.
- Added local-time conversion and pending-sleep recovery safeguards.

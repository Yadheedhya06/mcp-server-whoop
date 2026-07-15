# Security evidence

This project treats safety as a set of reproducible controls, not a marketing certificate. The controls below can be rerun from source and are enforced in GitHub Actions.

## Security boundary

`mcp-server-whoop` is local-first and uses standard MCP over stdio. It contacts only WHOOP's documented OAuth and Developer API origins. It has no hosted relay, telemetry, analytics, database, WHOOP write tools, raw SQL tool, or generic HTTP tool.

The MCP client receives only the filtered health metrics returned by a tool call. OAuth credentials never appear in MCP tool schemas or results. Health records are processed in memory and are not cached to disk by this package.

## Reproducible release checks

Run the same checks locally:

```bash
npm ci --ignore-scripts
npm run check
npm audit --audit-level=high
npm audit signatures
npm run security:sbom
```

`npm run check` performs:

1. Strict TypeScript compilation.
2. Unit and MCP integration tests with synthetic health data.
3. A real `npm pack` of the exact publishable artifact.
4. Tarball path allowlisting.
5. Secret and private-path pattern scanning inside every text file in the tarball.
6. Runtime dependency allowlisting and exact-version enforcement.
7. Install-lifecycle-script rejection.
8. Outbound source URL allowlisting.
9. Dynamic-code and arbitrary-process-execution rejection.
10. Verification that all five health tools declare read-only and non-destructive MCP annotations.

The generated CycloneDX SBOM is uploaded as a CI artifact.

## Automated independent tooling

The public workflows add independent scanners around the project-owned test suite:

- GitHub CodeQL for JavaScript and TypeScript static analysis.
- Gitleaks across repository history.
- GitHub Dependency Review on pull requests.
- OpenSSF Scorecard with public results and SARIF upload.
- npm advisory audit and registry-signature verification.
- Dependabot for npm and GitHub Actions updates.

All third-party GitHub Actions are pinned to full commit SHAs. Workflows use explicit least-privilege permissions and StepSecurity Harden-Runner in audit mode.

## Release integrity

The release workflow is designed for npm Trusted Publishing using GitHub OIDC. It uses short-lived, workflow-bound credentials and publishes with npm provenance. Future releases created by this workflow can be verified on npm against their source repository and workflow identity.

The npm trusted publisher must be configured for:

- Repository: `Yadheedhya06/mcp-server-whoop`
- Workflow: `publish.yml`
- Allowed action: `npm publish`

No long-lived npm token is required by the workflow.

## Tested security invariants

The public tests cover these boundaries:

- OAuth requests contain only the documented read scopes plus `offline`.
- OAuth state has at least 256 bits of random input and is compared in constant time.
- Automatic OAuth callbacks accept loopback HTTP redirect URIs only.
- Client secrets are entered through a masked prompt.
- Credential files reject symlinks, multiple hard links, ownership mismatches, and file swaps between path validation and open, then self-heal to mode `0600`; the default parent directory is current-user-owned and created with mode `0700`.
- Rotating refresh tokens are serialized with a lock and persisted atomically.
- Persisted rotated tokens take precedence over stale environment bootstrap tokens.
- WHOOP error bodies are not forwarded into AI-visible error messages.
- All MCP data tools are read-only, non-destructive, and idempotent. Their open-world access is constrained to WHOOP's API.
- Tool output excludes OAuth secrets, WHOOP record IDs, and raw UTC timestamps.
- Historical timestamps use each WHOOP record's own offset.
- Pending sleep never causes an older recovery to be presented as current.

## Honest limitations

This project has not undergone a paid independent penetration test, and this document is not a certification. OpenSSF Scorecard, CodeQL, Gitleaks, dependency review, tests, and provenance are independently verifiable evidence, but no scanner proves the absence of every vulnerability.

The client secret and OAuth grant are encrypted only if the user's disk or operating system provides encryption. The package protects the local file with OS permissions, but it does not use a platform keychain. A compromised user account, machine, MCP client, or dependency can still access data available to that process.

Please report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

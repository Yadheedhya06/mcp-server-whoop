# Security

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories instead of opening a public issue.

## Credential model

- Every user creates their own application in the WHOOP Developer Dashboard.
- Client secrets and OAuth tokens remain on the user's machine.
- Credentials are stored outside the npm package in a file with mode `0600` inside a directory with mode `0700`.
- Refresh-token rotation is serialized with a lock and persisted using atomic replacement.
- Tool responses never include OAuth tokens, client secrets, WHOOP user IDs, or raw API identifiers.
- The server is read-only and does not expose mutation tools.

Never commit credential files, `.env` files, access tokens, refresh tokens, or client secrets.

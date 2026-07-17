# mcp-server-whoop

[![npm version](https://img.shields.io/npm/v/mcp-server-whoop.svg)](https://www.npmjs.com/package/mcp-server-whoop)
[![CI](https://github.com/Yadheedhya06/mcp-server-whoop/actions/workflows/ci.yml/badge.svg)](https://github.com/Yadheedhya06/mcp-server-whoop/actions/workflows/ci.yml)
[![CodeQL and secrets](https://github.com/Yadheedhya06/mcp-server-whoop/actions/workflows/security.yml/badge.svg)](https://github.com/Yadheedhya06/mcp-server-whoop/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Yadheedhya06/mcp-server-whoop/badge)](https://scorecard.dev/viewer/?uri=github.com/Yadheedhya06/mcp-server-whoop)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local-first, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for WHOOP. It gives MCP-compatible AI clients compact recovery, sleep, strain, HRV, heart-rate, workout, and body-measurement signals without sending your WHOOP credentials through a hosted third party.

## Why this server

- Standard MCP over stdio, usable by any client that supports local MCP servers
- Local WHOOP OAuth flow with each user's own WHOOP developer application
- Access and rotating refresh tokens remain on the user's machine
- Five focused read-only tools instead of a noisy API dump
- Per-record local timestamps, so travel does not shift sleep or workout dates
- Explicit `processing` status, with no older recovery substituted while a new sleep is pending
- Score-derived metrics appear only for `SCORED` records; live current-cycle strain is labeled `provisional_strain`
- Human-scale hours, minutes, calories, and heart-rate-zone minutes
- No raw identifiers, OAuth secrets, or raw continuous heart-rate claims in tool output
- No hosted relay, telemetry, database, generic HTTP tool, raw SQL, or install lifecycle scripts
- Reproducible tarball security audit, CycloneDX SBOM, CodeQL, Gitleaks, dependency review, and OpenSSF Scorecard

> This is an independent community project. It is not affiliated with or endorsed by WHOOP. WHOOP data is useful coaching context, not medical advice.

## Requirements

- Node.js 18 or newer
- A WHOOP account
- A free application in the [WHOOP Developer Dashboard](https://developer.whoop.com/dashboard/)
- An MCP-compatible AI client

## Quick start

1. Create a WHOOP developer application and register `http://127.0.0.1:8765/callback`.
2. Enable the five read scopes and `offline` listed below.
3. Run `npx -y mcp-server-whoop@0.2.2 auth` in a terminal and approve WHOOP access.
4. Run `npx -y mcp-server-whoop@0.2.2 status` to confirm the local grant exists.
5. Add the stdio command `npx -y mcp-server-whoop@0.2.2` to your AI client's MCP configuration.
6. Restart or reload the client, then ask: `Use WHOOP to summarize my recovery and sleep from the last 7 days.`

The authorization command and the AI client must run as the same operating-system user, or both must set `WHOOP_CREDENTIALS_FILE` to the same private file. The package never asks you to paste WHOOP tokens into an AI conversation.

The documentation pins an exact reviewed version by default. Use `@latest` only if you explicitly want your client to follow future releases without reviewing them first.

## 1. Create your WHOOP application

Create an application in the WHOOP Developer Dashboard and register this exact redirect URL:

```text
http://127.0.0.1:8765/callback
```

Enable these scopes:

```text
offline
read:recovery
read:cycles
read:sleep
read:workout
read:body_measurement
```

`offline` is required because WHOOP access tokens expire and WHOOP rotates refresh tokens.

## 2. Authorize locally

Run:

```bash
npx -y mcp-server-whoop@0.2.2 auth
```

The command prompts for your WHOOP client ID and masks the client secret, opens WHOOP consent in your browser, validates the OAuth state, and saves the resulting grant locally.

Credentials are stored at:

```text
~/.config/mcp-server-whoop/credentials.json
```

On Linux and macOS, every path ancestor is checked before use, the direct directory is current-user-owned with mode `0700`, and the file is a single-link current-user-owned regular file with mode `0600`. Override the path with `WHOOP_CREDENTIALS_FILE` only when every ancestor is trusted and is not a symlink.

Persistent OAuth credentials intentionally fail closed on native Windows. Node.js file modes do not enforce private Windows ACLs, and its standard file APIs cannot guarantee reparse-safe credential writes. Native Windows users can provide a short-lived `WHOOP_ACCESS_TOKEN` through the MCP process environment, but automatic authorization and refresh-token persistence require WSL, Linux, or macOS until a native credential backend is available.

For headless environments, provide `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, and optionally `WHOOP_REDIRECT_URI` as environment variables before running `auth`.

The OAuth callback still needs to reach the machine running `auth`. When authorizing over SSH, create a loopback tunnel from your workstation first:

```bash
ssh -L 8765:127.0.0.1:8765 user@your-server
```

Then run `auth` in that SSH session and open its printed WHOOP URL in your workstation browser. Do not pass the client secret as a command-line argument because shell history and process listings may expose it.

Check setup without displaying secrets:

```bash
npx -y mcp-server-whoop@0.2.2 status
```

Remove the local grant:

```bash
npx -y mcp-server-whoop@0.2.2 logout
```

Revoking access in WHOOP account settings is also recommended when you no longer use an integration.

## 3. Add it to an AI client

### Claude Desktop

Add this under `mcpServers` in Claude Desktop's configuration, then fully restart Claude Desktop:

```json
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": ["-y", "mcp-server-whoop@0.2.2"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio whoop -- npx -y mcp-server-whoop@0.2.2
```

### Cursor, Windsurf, Gemini Code Assist, and other `mcpServers` clients

Add the server to the client's MCP JSON. Gemini Code Assist uses `~/.gemini/settings.json`; other clients choose their own settings path.

```json
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": ["-y", "mcp-server-whoop@0.2.2"]
    }
  }
}
```

### VS Code

Create `.vscode/mcp.json` for a project, or use VS Code's **MCP: Add Server** command:

```json
{
  "servers": {
    "whoop": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-whoop@0.2.2"]
    }
  }
}
```

### Codex

Either run:

```bash
codex mcp add whoop -- npx -y mcp-server-whoop@0.2.2
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.whoop]
command = "npx"
args = ["-y", "mcp-server-whoop@0.2.2"]
```

### ChatGPT

Local Codex and ChatGPT desktop clients that support stdio can use the Codex configuration above. ChatGPT web does not launch a command on your computer; it requires a separately secured remote bridge or tunnel and a workspace plugin. This repository intentionally does not ship or operate a public health-data relay.

Client menus and configuration paths change over time. If a client supports standard local stdio MCP, the portable values are always:

```text
command: npx
arguments: -y mcp-server-whoop@0.2.2
```

## Confirm the connection

After restarting the client, confirm that it discovers exactly these five tools:

```text
whoop_latest_overview
whoop_recovery_history
whoop_sleep_history
whoop_cycle_strain_history
whoop_workout_history
```

Useful prompts:

- `Use WHOOP to review today's recovery, latest sleep, current strain, and latest workout.`
- `Compare my recovery, HRV, and resting heart rate over the last 14 days.`
- `Show my last 7 days of sleep, including naps, and flag anything still processing.`
- `Summarize my workout strain and heart-rate zones for the last 30 days.`
- `Use WHOOP as context for today's training, but do not treat it as medical advice.`

The model decides when to call tools, so explicitly say `Use WHOOP` when you want live data rather than a general answer.

## Tools

| Tool | Purpose |
|---|---|
| `whoop_latest_overview` | Current coaching snapshot with pending-data safeguards |
| `whoop_recovery_history` | Recovery, HRV, resting HR, SpO2, and skin-temperature trends |
| `whoop_sleep_history` | Primary sleep and optional naps, stages, need, quality, and timing |
| `whoop_cycle_strain_history` | Daily strain, calories, and average/max heart rate |
| `whoop_workout_history` | Sport, duration, strain, HR, calories, distance, and zone minutes |

All tools are marked read-only, non-destructive, and idempotent.

### Why deliberately only five tools?

For a health-data MCP, a larger tool count also means a larger capability surface. This server keeps authentication outside the agent and gives the model only the five health-reading capabilities it needs.

It intentionally has:

- no WHOOP write, revoke, token-management, or authorization-code tools
- no profile/email/name scope
- no raw-record, raw-ID, arbitrary endpoint, SQL, file, or shell tool
- no hosted OAuth relay, telemetry service, health-data cache, or database
- no stale-recovery fallback when the newest sleep is still processing

The goal is not maximum WHOOP API coverage. It is the smallest practical authority boundary for recovery-aware AI.

## Data semantics

WHOOP returns absolute timestamps plus a `timezone_offset` on sleep, cycle, and workout records. This server applies each record's own offset and returns only already-converted local timestamps such as:

```text
2026-07-07 18:02:22 +04:00
```

It does not apply the machine's current timezone to historical records.

WHOOP exposes activity type and workout sport, but its public API does not indicate whether a workout was auto-detected or manually started. This server does not guess.

When the newest primary sleep is still `PENDING_SCORE`, the latest overview returns:

```json
{
  "status": {
    "state": "waiting_for_whoop",
    "current_recovery_available": false
  },
  "recovery": null
}
```

An older recovery is never presented as current.

## Environment variables

| Variable | Purpose |
|---|---|
| `WHOOP_CLIENT_ID` | WHOOP OAuth client ID |
| `WHOOP_CLIENT_SECRET` | WHOOP OAuth client secret |
| `WHOOP_REDIRECT_URI` | OAuth callback, defaults to `http://127.0.0.1:8765/callback` |
| `WHOOP_CREDENTIALS_FILE` | Override local credential-file path |
| `WHOOP_ACCESS_TOKEN` | Optional short-lived access-token override |
| `WHOOP_REFRESH_TOKEN` | Optional refresh-token override |
| `WHOOP_TOKEN_EXPIRES_AT` | Optional ISO token-expiry override |

Client configuration from `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, and `WHOOP_REDIRECT_URI` overrides file values. Token environment variables can bootstrap a headless setup, but once a refresh token rotates, the newer token persisted in the credential file takes precedence. Do not put secrets directly in command-line arguments or commit them to source control.

## Troubleshooting

### `Missing WHOOP ...`

Run `npx -y mcp-server-whoop@0.2.2 status` as the same OS user that launches the AI client. If the credentials are elsewhere, set `WHOOP_CREDENTIALS_FILE` in the client's MCP environment.

### WHOOP reports a redirect mismatch

The redirect in the Developer Dashboard and the value used by this package must match exactly. The default is `http://127.0.0.1:8765/callback`, including scheme, host, port, and path.

### The browser does not open

Copy the authorization URL printed in the terminal and open it manually. The callback listener expires after five minutes; rerun `auth` if needed.

### Port `8765` is already in use

Register another loopback URL such as `http://127.0.0.1:9876/callback`, set `WHOOP_REDIRECT_URI` to that exact value, and rerun `auth`.

### Recovery is `null`

Check the returned `status.state`. If it is `waiting_for_whoop` or `waiting_for_recovery`, WHOOP has not finished scoring the newest sleep. The server intentionally refuses to label an older recovery as current; retry after WHOOP finishes processing.

### The client shows no tools

Run `npx -y mcp-server-whoop@0.2.2 --help` in a terminal to verify Node.js and npm can launch the package, then restart the AI client and inspect its MCP logs. Do not run the bare server interactively to inspect output: stdio is reserved for MCP protocol messages.

## Development

```bash
git clone git@github.com:Yadheedhya06/mcp-server-whoop.git
cd mcp-server-whoop
npm ci --ignore-scripts
npm run check
```

Run the local source server:

```bash
npm run dev
```

Build and inspect the exact npm artifact:

```bash
npm pack --dry-run
```

## Privacy and security

This project publishes evidence rather than claiming that any package is perfectly safe. See the full [security policy](SECURITY.md) and [reproducible security evidence](SECURITY-EVIDENCE.md).

- Every user owns their WHOOP developer app and OAuth grant.
- Credentials stay local and are never returned through MCP tools.
- The package provides no WHOOP write, generic network, shell, filesystem, or raw API passthrough tool.
- On supported POSIX storage, the credential file and every ancestor are checked against symlinks, unsafe ownership or permissions, oversized input, and unexpected fields. Refresh rotation uses a heartbeat lease that does not trust PIDs, an exclusive temporary file, atomic replacement, post-write verification, and disk sync. Native Windows persistence fails closed.
- WHOOP and OAuth responses are size-bounded and structurally validated; provider response bodies are never copied into MCP errors.
- Direct dependencies use exact versions. There are only two direct runtime dependencies and no package install lifecycle scripts.
- CI runs the full test suite on Node 18, 20, 22, and 24, adds macOS and Windows platform-security jobs, audits both source and the exact compiled npm runtime, verifies npm registry signatures, and generates a CycloneDX SBOM.
- Independent workflows run CodeQL, Gitleaks, dependency review, and OpenSSF Scorecard.
- The publish workflow packs once and publishes that exact tarball through npm Trusted Publishing with Sigstore provenance. GitHub separately attests that tarball against its CycloneDX SBOM; no long-lived npm token is used.

These controls reduce risk, but they are not a paid penetration test or a guarantee. The limitations are documented explicitly in `SECURITY-EVIDENCE.md`.

## License

MIT

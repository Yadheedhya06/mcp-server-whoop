# mcp-server-whoop

[![npm version](https://img.shields.io/npm/v/mcp-server-whoop.svg)](https://www.npmjs.com/package/mcp-server-whoop)
[![CI](https://github.com/Yadheedhya06/mcp-server-whoop/actions/workflows/ci.yml/badge.svg)](https://github.com/Yadheedhya06/mcp-server-whoop/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local-first, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for WHOOP. It gives MCP-compatible AI clients compact recovery, sleep, strain, HRV, heart-rate, workout, and body-measurement signals without sending your WHOOP credentials through a hosted third party.

## Why this server

- Standard MCP over stdio, usable by any client that supports local MCP servers
- Local WHOOP OAuth flow with each user's own WHOOP developer application
- Access and rotating refresh tokens remain on the user's machine
- Five focused read-only tools instead of a noisy API dump
- Per-record local timestamps, so travel does not shift sleep or workout dates
- Explicit `processing` status, with no older recovery substituted while a new sleep is pending
- Human-scale hours, minutes, calories, and heart-rate-zone minutes
- No raw identifiers, OAuth secrets, or raw continuous heart-rate claims in tool output

> This is an independent community project. It is not affiliated with or endorsed by WHOOP. WHOOP data is useful coaching context, not medical advice.

## Requirements

- Node.js 18 or newer
- A WHOOP account
- A free application in the [WHOOP Developer Dashboard](https://developer.whoop.com/dashboard/)
- An MCP-compatible AI client

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
npx -y mcp-server-whoop@latest auth
```

The command prompts for your WHOOP client ID and masks the client secret, opens WHOOP consent in your browser, validates the OAuth state, and saves the resulting grant locally.

Credentials are stored at:

```text
~/.config/mcp-server-whoop/credentials.json
```

The directory is forced to mode `0700` and the file to `0600`. Override the path with `WHOOP_CREDENTIALS_FILE` if needed.

For headless environments, provide `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, and optionally `WHOOP_REDIRECT_URI` as environment variables before running `auth`.

Check setup without displaying secrets:

```bash
npx -y mcp-server-whoop@latest status
```

Remove the local grant:

```bash
npx -y mcp-server-whoop@latest logout
```

Revoking access in WHOOP account settings is also recommended when you no longer use an integration.

## 3. Add it to an AI client

### Claude Desktop

```json
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": ["-y", "mcp-server-whoop@latest"]
    }
  }
}
```

### Cursor, Windsurf, VS Code, and other JSON-based clients

Use the same command and arguments:

```json
{
  "command": "npx",
  "args": ["-y", "mcp-server-whoop@latest"]
}
```

### Codex

```toml
[mcp_servers.whoop]
command = "npx"
args = ["-y", "mcp-server-whoop@latest"]
```

### ChatGPT

ChatGPT does not directly launch a local stdio command. Run this package behind an MCP-compatible secure tunnel or remote bridge, then create a developer plugin using that tunnel. The MCP server itself requires no additional auth because WHOOP OAuth is handled locally by this package.

## Tools

| Tool | Purpose |
|---|---|
| `whoop_latest_overview` | Current coaching snapshot with pending-data safeguards |
| `whoop_recovery_history` | Recovery, HRV, resting HR, SpO2, and skin-temperature trends |
| `whoop_sleep_history` | Primary sleep and optional naps, stages, need, quality, and timing |
| `whoop_cycle_strain_history` | Daily strain, calories, and average/max heart rate |
| `whoop_workout_history` | Sport, duration, strain, HR, calories, distance, and zone minutes |

All tools are marked read-only, non-destructive, and idempotent.

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

## Development

```bash
git clone git@github.com:Yadheedhya06/mcp-server-whoop.git
cd mcp-server-whoop
npm install
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

See [SECURITY.md](SECURITY.md). In short:

- Every user owns their WHOOP developer app and OAuth grant.
- Credentials stay local and are never returned through MCP tools.
- Refreshes use bounded timeouts, a shared lock, atomic persistence, and restrictive permissions.
- The package provides no WHOOP write or mutation tools.

## License

MIT

#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { authorize } from "./auth.js";
import { CredentialStore } from "./config.js";
import { createWhoopServer } from "./server.js";

const HELP = `mcp-server-whoop - local-first WHOOP MCP server

Usage:
  mcp-server-whoop             Start the MCP server over stdio
  mcp-server-whoop serve       Start the MCP server over stdio
  mcp-server-whoop auth        Authorize a WHOOP account locally
  mcp-server-whoop status      Show credential status without secrets
  mcp-server-whoop logout      Delete locally stored WHOOP credentials
  mcp-server-whoop help        Show this help

Before auth, set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET and register
http://127.0.0.1:8765/callback in the WHOOP Developer Dashboard.

Persistent OAuth credentials require Linux, macOS, or WSL.
Native Windows supports short-lived WHOOP_ACCESS_TOKEN values only.`;

async function serve(): Promise<void> {
  const server = createWhoopServer();
  await server.connect(new StdioServerTransport());
}

async function status(): Promise<void> {
  const store = new CredentialStore();
  const credentials = await store.load();
  if (process.platform === "win32") {
    console.log("Persistent credentials: disabled on native Windows");
    console.log(`Environment access token configured: ${Boolean(credentials.accessToken)}`);
    console.log("Use WSL/Linux/macOS for OAuth and rotating refresh-token persistence.");
    return;
  }
  console.log(`Credentials file: ${store.path}`);
  console.log(`Client configured: ${Boolean(credentials.clientId && credentials.clientSecret)}`);
  console.log(`Access token present: ${Boolean(credentials.accessToken)}`);
  console.log(`Refresh token present: ${Boolean(credentials.refreshToken)}`);
  console.log(
    `Token expiry: ${credentials.expiresAt ? new Date(credentials.expiresAt).toLocaleString() : "unknown"}`,
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] || "serve";
  if (command === "serve") return serve();
  if (command === "auth") return authorize();
  if (command === "status") return status();
  if (command === "logout") {
    const store = new CredentialStore();
    await store.clear();
    console.log(`Removed locally stored WHOOP credentials from ${store.path}`);
    return;
  }
  if (["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

export { createWhoopServer } from "./server.js";
export { WhoopClient } from "./whoop.js";

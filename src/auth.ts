import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { CredentialStore } from "./config.js";
import type { OAuthTokenResponse } from "./types.js";

export const AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/callback";
export const DEFAULT_SCOPES = [
  "offline",
  "read:recovery",
  "read:cycles",
  "read:sleep",
  "read:workout",
  "read:body_measurement",
];

async function promptText(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive auth requires a terminal. Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in non-interactive environments.");
  }
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await input.question(question)).trim();
  } finally {
    input.close();
  }
}

async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("A TTY is required for the hidden secret prompt. Set WHOOP_CLIENT_SECRET in non-interactive environments.");
  }
  process.stderr.write(question);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      if (!wasRaw) process.stdin.pause();
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          process.stderr.write("\n");
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\u0003") {
          process.stderr.write("\n");
          cleanup();
          reject(new Error("Authorization cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
          continue;
        }
        value += character;
        process.stderr.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
}

export function createAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  if (!/^[A-Za-z0-9_-]{8}$/.test(options.state)) {
    throw new Error("WHOOP OAuth state must be exactly eight safe characters");
  }
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", (options.scopes || DEFAULT_SCOPES).join(" "));
  url.searchParams.set("state", options.state);
  return url.toString();
}

async function exchangeCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<OAuthTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`WHOOP authorization exchange failed (${response.status}): ${detail}`);
  }
  const tokens = (await response.json()) as OAuthTokenResponse;
  if (!tokens.access_token) throw new Error("WHOOP returned no access token");
  return tokens;
}

function tryOpenBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command[0] as string, command[1] as string[], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL is the portable fallback.
  }
}

export async function authorize(store = new CredentialStore()): Promise<void> {
  const existing = await store.load();
  const clientId =
    existing.clientId || (await promptText("WHOOP client ID: "));
  const clientSecret =
    existing.clientSecret || (await promptSecret("WHOOP client secret: "));
  if (!clientId || !clientSecret) {
    throw new Error("WHOOP client ID and client secret are required");
  }
  const redirectUri = existing.redirectUri || DEFAULT_REDIRECT_URI;
  const redirect = new URL(redirectUri);
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)
  ) {
    throw new Error("Local auth requires an http://localhost or http://127.0.0.1 redirect URI");
  }
  const port = Number(redirect.port || 80);
  const state = randomBytes(6).toString("base64url").slice(0, 8);
  const authorizationUrl = createAuthorizationUrl({ clientId, redirectUri, state });

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("WHOOP authorization timed out after five minutes"));
    }, 300_000);
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", redirectUri);
      if (requestUrl.pathname !== redirect.pathname) {
        response.writeHead(404).end("Not found");
        return;
      }
      const returnedState = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");
      const authorizationCode = requestUrl.searchParams.get("code");
      if (error) {
        clearTimeout(timeout);
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end(`WHOOP authorization failed: ${error}`);
        server.close();
        reject(new Error(`WHOOP authorization failed: ${error}`));
        return;
      }
      if (returnedState !== state || !authorizationCode) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end("Invalid OAuth callback");
        return;
      }
      clearTimeout(timeout);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>WHOOP connected</h1><p>You can close this window.</p>");
      server.close();
      resolve(authorizationCode);
    });
    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(port, redirect.hostname, () => {
      console.error("Open this URL to authorize WHOOP:");
      console.error(authorizationUrl);
      tryOpenBrowser(authorizationUrl);
    });
  });

  const tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });
  const expiresIn = Number(tokens.expires_in || 3600);
  await store.update({
    clientId,
    clientSecret,
    redirectUri,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    tokenType: tokens.token_type || "bearer",
    scope: tokens.scope || DEFAULT_SCOPES.join(" "),
  });
  console.error(`WHOOP authorization saved securely to ${store.path}`);
}

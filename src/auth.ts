import { randomBytes, timingSafeEqual } from "node:crypto";
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
        if (character === "\u0003" || character === "\u0004") {
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
        if (Buffer.byteLength(value, "utf8") >= 16 * 1024) continue;
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
}): string {
  if (
    !options.clientId ||
    options.clientId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(options.clientId)
  ) {
    throw new Error("WHOOP client ID is empty, oversized, or contains control characters");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.state)) {
    throw new Error("WHOOP OAuth state must contain 32 to 128 safe characters");
  }
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", DEFAULT_SCOPES.join(" "));
  url.searchParams.set("state", options.state);
  return url.toString();
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error("WHOOP token response exceeded the size limit");
  }
  if (!response.body) throw new Error("WHOOP returned an empty token response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("WHOOP token response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("WHOOP returned invalid token JSON");
  }
}

function isOAuthTokenResponse(value: unknown): value is OAuthTokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as Record<string, unknown>;
  if (
    typeof token.access_token !== "string" ||
    token.access_token.length < 1 ||
    Buffer.byteLength(token.access_token, "utf8") > 16 * 1024
  ) return false;
  if (
    token.refresh_token !== undefined &&
    (typeof token.refresh_token !== "string" ||
      Buffer.byteLength(token.refresh_token, "utf8") > 16 * 1024)
  ) return false;
  if (
    token.token_type !== undefined &&
    (typeof token.token_type !== "string" || Buffer.byteLength(token.token_type, "utf8") > 128)
  ) return false;
  if (
    token.scope !== undefined &&
    (typeof token.scope !== "string" || Buffer.byteLength(token.scope, "utf8") > 2_048)
  ) return false;
  if (token.expires_in !== undefined) {
    const expiry = Number(token.expires_in);
    if (!Number.isFinite(expiry) || expiry <= 0 || expiry > 31_536_000) return false;
  }
  return true;
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
    await response.body?.cancel();
    throw new Error(`WHOOP authorization exchange failed (${response.status})`);
  }
  const tokens = await readBoundedJson(response, 64 * 1024);
  if (!isOAuthTokenResponse(tokens)) {
    throw new Error("WHOOP returned an invalid token response");
  }
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
      shell: false,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL is the portable fallback.
  }
}

const callbackHeaders = (contentType: string) => ({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Content-Type": contentType,
  "X-Content-Type-Options": "nosniff",
});

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
  const redirect = validateLocalRedirectUri(redirectUri);
  const port = Number(redirect.port);
  const state = randomBytes(32).toString("base64url");
  const authorizationUrl = createAuthorizationUrl({ clientId, redirectUri, state });

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("WHOOP authorization timed out after five minutes"));
    }, 300_000);
    const server = createServer((request, response) => {
      if (request.method !== "GET") {
        response.writeHead(405, { ...callbackHeaders("text/plain; charset=utf-8"), Allow: "GET" });
        response.end("Method not allowed");
        return;
      }
      const requestUrl = new URL(request.url || "/", redirectUri);
      if (requestUrl.pathname !== redirect.pathname) {
        response.writeHead(404, callbackHeaders("text/plain; charset=utf-8")).end("Not found");
        return;
      }
      const returnedState = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");
      const authorizationCode = requestUrl.searchParams.get("code");
      if (!safeEqual(returnedState, state)) {
        response.writeHead(400, callbackHeaders("text/plain; charset=utf-8"));
        response.end("Invalid OAuth callback");
        return;
      }
      if (error) {
        clearTimeout(timeout);
        response.writeHead(400, callbackHeaders("text/plain; charset=utf-8"));
        response.end("WHOOP authorization failed");
        server.close();
        reject(new Error("WHOOP authorization failed"));
        return;
      }
      if (
        !authorizationCode ||
        Buffer.byteLength(authorizationCode, "utf8") > 8_192 ||
        /[\u0000-\u001f\u007f]/.test(authorizationCode)
      ) {
        response.writeHead(400, callbackHeaders("text/plain; charset=utf-8"));
        response.end("Invalid OAuth callback");
        return;
      }
      clearTimeout(timeout);
      response.writeHead(200, callbackHeaders("text/html; charset=utf-8"));
      response.end("<h1>WHOOP connected</h1><p>You can close this window.</p>");
      server.close();
      resolve(authorizationCode);
    });
    server.maxRequestsPerSocket = 20;
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
  const expiresIn = Number(tokens.expires_in ?? 3600);
  await store.withLock(async () => {
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
  });
  console.error(`WHOOP authorization saved securely to ${store.path}`);
}

export function validateLocalRedirectUri(raw: string): URL {
  const redirect = new URL(raw);
  if (
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)
  ) {
    throw new Error("Local auth requires an http://localhost or http://127.0.0.1 redirect URI");
  }
  if (redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error("Local redirect URI cannot contain credentials, query parameters, or a fragment");
  }
  const port = Number(redirect.port);
  if (!redirect.port || !Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("Local redirect URI requires an explicit port from 1024 to 65535");
  }
  return redirect;
}

function safeEqual(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

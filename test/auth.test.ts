import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  AUTHORIZE_URL,
  DEFAULT_SCOPES,
  createAuthorizationUrl,
  validateLocalRedirectUri,
  waitForOAuthCallback,
} from "../src/auth.js";

const strongState = "A".repeat(43);

test("authorization URL uses WHOOP auth endpoint, exact state, callback, and read-only scopes", () => {
  const value = createAuthorizationUrl({
    clientId: "public-client-id",
    redirectUri: "http://127.0.0.1:8765/callback",
    state: strongState,
  });
  const url = new URL(value);
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "public-client-id");
  assert.equal(url.searchParams.get("state"), strongState);
  assert.deepEqual(url.searchParams.get("scope")?.split(" "), DEFAULT_SCOPES);
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("authorization scopes contain only documented read scopes and offline refresh", () => {
  assert.deepEqual(DEFAULT_SCOPES, [
    "offline",
    "read:recovery",
    "read:cycles",
    "read:sleep",
    "read:workout",
    "read:body_measurement",
  ]);
  assert.equal(DEFAULT_SCOPES.some((scope) => scope.startsWith("write:")), false);
});

test("authorization URL rejects weak or malformed OAuth state", () => {
  for (const state of ["too-short", "A".repeat(31), `${"A".repeat(32)}!`]) {
    assert.throws(
      () =>
        createAuthorizationUrl({
          clientId: "client",
          redirectUri: "http://127.0.0.1:8765/callback",
          state,
        }),
      /32 to 128 safe characters/,
    );
  }
});

test("automatic OAuth callback accepts only plain loopback HTTP redirect URIs", () => {
  assert.doesNotThrow(() => validateLocalRedirectUri("http://127.0.0.1:8765/callback"));
  assert.doesNotThrow(() => validateLocalRedirectUri("http://localhost:8765/callback"));
  assert.doesNotThrow(() => validateLocalRedirectUri("http://[::1]:8765/callback"));

  for (const uri of [
    "https://127.0.0.1:8765/callback",
    "http://192.168.1.10:8765/callback",
    "http://example.com:8765/callback",
    "http://user:pass@127.0.0.1:8765/callback",
    "http://127.0.0.1:8765/callback?forward=1",
    "http://127.0.0.1:8765/callback#fragment",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:80/callback",
    "http://127.0.0.1:0/callback",
    "http://127.0.0.1:70000/callback",
  ]) {
    assert.throws(() => validateLocalRedirectUri(uri));
  }
});

test("OAuth callback pre-bind fails before authorization is exposed", async () => {
  const blocker = createServer((_request, response) => response.end("blocked"));
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const address = blocker.address();
  if (!address || typeof address === "string") throw new Error("Expected an IP listener");
  let ready = false;
  try {
    await assert.rejects(
      waitForOAuthCallback({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        state: "state-value",
        timeoutMs: 1_000,
        onListening: () => {
          ready = true;
        },
      }),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
    assert.equal(ready, false);
  } finally {
    blocker.close();
    await once(blocker, "close");
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORIZE_URL,
  DEFAULT_SCOPES,
  createAuthorizationUrl,
} from "../src/auth.js";

test("authorization URL uses WHOOP auth endpoint, exact state, callback, and read-only scopes", () => {
  const value = createAuthorizationUrl({
    clientId: "public-client-id",
    redirectUri: "http://127.0.0.1:8765/callback",
    state: "Abc_1234",
  });
  const url = new URL(value);
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "public-client-id");
  assert.equal(url.searchParams.get("state"), "Abc_1234");
  assert.deepEqual(url.searchParams.get("scope")?.split(" "), DEFAULT_SCOPES);
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("authorization URL rejects an unsafe OAuth state", () => {
  assert.throws(
    () =>
      createAuthorizationUrl({
        clientId: "client",
        redirectUri: "http://127.0.0.1:8765/callback",
        state: "too-long-state",
      }),
    /exactly eight/,
  );
});

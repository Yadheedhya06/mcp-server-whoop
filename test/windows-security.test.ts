import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialStore } from "../src/config.js";

const windowsOnly = process.platform === "win32" ? test : test.skip;

windowsOnly("Windows allows environment-only access tokens but fails closed for persistent credentials", async () => {
  const accessKey = ["WHOOP", "ACCESS", "TOKEN"].join("_");
  const previous = process.env[accessKey];
  process.env[accessKey] = "short-lived-access-token";
  try {
    const store = new CredentialStore(join(tmpdir(), "must-not-be-created", "credentials.json"));
    assert.equal((await store.load()).accessToken, "short-lived-access-token");
    assert.throws(
      () => store.assertPersistentStorageSupported(),
      /credential persistence is disabled on native Windows/,
    );
    await assert.rejects(
      store.update({ refreshToken: "must-not-persist" }),
      /credential persistence is disabled on native Windows/,
    );
    await assert.rejects(
      store.withLock(async () => "must-not-run"),
      /credential persistence is disabled on native Windows/,
    );
  } finally {
    if (previous === undefined) delete process.env[accessKey];
    else process.env[accessKey] = previous;
  }
});

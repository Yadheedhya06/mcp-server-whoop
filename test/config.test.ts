import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/config.js";

test("CredentialStore persists only to a private file and directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "whoop-config-"));
  const path = join(root, "nested", "credentials.json");
  const store = new CredentialStore(path);
  await store.update({
    clientId: "client-test",
    clientSecret: "secret-test",
    accessToken: "access-test",
  });
  const loaded = await store.loadFile();
  assert.equal(loaded.clientId, "client-test");
  assert.equal(loaded.accessToken, "access-test");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "nested"))).mode & 0o777, 0o700);
});

test("CredentialStore serializes concurrent updates without losing token rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "whoop-lock-"));
  const store = new CredentialStore(join(root, "credentials.json"));
  await store.update({ clientId: "client", refreshToken: "refresh-old" });
  await Promise.all([
    store.withLock(async () => {
      await store.update({ accessToken: "access-new" });
    }),
    store.withLock(async () => {
      await store.update({ refreshToken: "refresh-new" });
    }),
  ]);
  const loaded = await store.loadFile();
  assert.equal(loaded.accessToken, "access-new");
  assert.equal(loaded.refreshToken, "refresh-new");
});

test("persisted rotated credentials take precedence over bootstrap environment values", async () => {
  const root = await mkdtemp(join(tmpdir(), "whoop-env-value-"));
  const store = new CredentialStore(join(root, "credentials.json"));
  const accessKey = ["WHOOP", "ACCESS", "TOKEN"].join("_");
  const refreshKey = ["WHOOP", "REFRESH", "TOKEN"].join("_");
  const previousAccess = process.env[accessKey];
  const previousRefresh = process.env[refreshKey];
  Reflect.set(process.env, accessKey, "temporary-value-a");
  Reflect.set(process.env, refreshKey, "temporary-value-r");
  try {
    assert.equal((await store.load()).accessToken, "temporary-value-a");
    await store.update({
      accessToken: "persisted-value-a",
      refreshToken: "persisted-value-r",
    });
    const loaded = await store.load();
    assert.equal(loaded.accessToken, "persisted-value-a");
    assert.equal(loaded.refreshToken, "persisted-value-r");
  } finally {
    if (previousAccess === undefined) delete process.env[accessKey];
    else Reflect.set(process.env, accessKey, previousAccess);
    if (previousRefresh === undefined) delete process.env[refreshKey];
    else Reflect.set(process.env, refreshKey, previousRefresh);
  }
});

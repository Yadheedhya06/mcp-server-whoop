import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

test("CredentialStore self-heals an overly broad credential-file mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "whoop-mode-"));
  const path = join(root, "credentials.json");
  await writeFile(path, '{"accessToken":"value"}\n', { mode: 0o644 });
  await chmod(path, 0o644);
  const store = new CredentialStore(path);
  assert.equal((await store.loadFile()).accessToken, "value");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("CredentialStore rejects credential-file symlinks", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink permissions differ on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "whoop-symlink-"));
  const target = join(root, "target.json");
  const link = join(root, "credentials.json");
  await writeFile(target, '{"accessToken":"must-not-load"}\n', { mode: 0o600 });
  await symlink(target, link);
  const store = new CredentialStore(link);
  await assert.rejects(store.loadFile(), /regular file, not a symlink/);
  await assert.rejects(store.update({ accessToken: "replacement" }), /regular file, not a symlink/);
  assert.equal(await readFile(target, "utf8"), '{"accessToken":"must-not-load"}\n');
});

test("CredentialStore rejects a shared parent instead of changing its permissions", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX permission checks do not apply on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "whoop-parent-mode-"));
  const shared = join(root, "shared");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  const store = new CredentialStore(join(shared, "credentials.json"));
  await writeFile(store.path, '{"accessToken":"value"}\n', { mode: 0o600 });
  await assert.rejects(
    store.loadFile(),
    /parent directory must not be accessible/,
  );
  await assert.rejects(
    store.update({ accessToken: "value" }),
    /parent directory must not be accessible/,
  );
  assert.equal((await stat(shared)).mode & 0o777, 0o755);
});

test("CredentialStore rejects multiply linked credential files", async (context) => {
  if (process.platform === "win32") {
    context.skip("hard-link behavior differs on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "whoop-hardlink-"));
  const target = join(root, "target.json");
  const path = join(root, "credentials.json");
  await writeFile(target, '{"accessToken":"must-not-load"}\n', { mode: 0o600 });
  await link(target, path);
  await assert.rejects(
    new CredentialStore(path).loadFile(),
    /multiple links/,
  );
});

test("CredentialStore rejects oversized files and fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "whoop-size-"));
  const path = join(root, "credentials.json");
  const store = new CredentialStore(path);
  await writeFile(path, `{"accessToken":"${"a".repeat(70 * 1024)}"}`, { mode: 0o600 });
  await assert.rejects(store.loadFile(), /exceeds the 64 KiB safety limit/);
  await assert.rejects(
    store.update({ accessToken: "a".repeat(17 * 1024) }),
    /invalid or oversized fields/,
  );
});

test("CredentialStore rejects unknown fields and non-string credential values", async () => {
  const root = await mkdtemp(join(tmpdir(), "whoop-shape-"));
  const path = join(root, "credentials.json");
  const store = new CredentialStore(path);
  for (const value of [
    '["access-token"]',
    '{"accessToken":123}',
    '{"accessToken":"ok","unexpected":"field"}',
  ]) {
    await writeFile(path, `${value}\n`, { mode: 0o600 });
    await assert.rejects(store.loadFile(), /only documented, bounded string fields/);
  }
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

test("CredentialStore reclaims a lock owned by a dead process without waiting for timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "whoop-dead-lock-"));
  const path = join(root, "credentials.json");
  const store = new CredentialStore(path);
  await store.update({ accessToken: "initial" });
  await writeFile(`${path}.lock`, "2147483647:dead-owner\n", { mode: 0o600 });
  const started = Date.now();
  const result = await store.withLock(async () => "acquired");
  assert.equal(result, "acquired");
  assert.ok(Date.now() - started < 2_000);
  await assert.rejects(readFile(`${path}.lock`, "utf8"), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT",
  );
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

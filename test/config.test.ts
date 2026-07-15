import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { CredentialStore } from "../src/config.js";

const secureTemp = async (prefix: string) =>
  realpath(await mkdtemp(join(tmpdir(), prefix)));

test("CredentialStore persists only to a private file and directory", async () => {
  const root = await secureTemp("whoop-config-");
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
  const root = await secureTemp("whoop-mode-");
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
  const root = await secureTemp("whoop-symlink-");
  const target = join(root, "target.json");
  const link = join(root, "credentials.json");
  await writeFile(target, '{"accessToken":"must-not-load"}\n', { mode: 0o600 });
  await symlink(target, link);
  const store = new CredentialStore(link);
  await assert.rejects(store.loadFile(), /regular file, not a symlink/);
  await assert.rejects(store.update({ accessToken: "replacement" }), /regular file, not a symlink/);
  assert.equal(await readFile(target, "utf8"), '{"accessToken":"must-not-load"}\n');
});

test("CredentialStore rejects symlinks anywhere in the credential ancestor chain", async (context) => {
  if (process.platform === "win32") {
    context.skip("persistent credential storage fails closed on Windows");
    return;
  }
  const root = await secureTemp("whoop-ancestor-link-");
  const target = join(root, "target");
  const linkedAncestor = join(root, "linked");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, linkedAncestor, "dir");
  const store = new CredentialStore(join(linkedAncestor, "private", "credentials.json"));
  await assert.rejects(
    store.update({ accessToken: "must-not-write" }),
    /ancestors must be real directories, not symlinks/,
  );
  await assert.rejects(readFile(join(target, "private", "credentials.json")), /ENOENT/);
});

test("CredentialStore rejects non-sticky writable credential ancestors", async (context) => {
  if (process.platform === "win32") {
    context.skip("persistent credential storage fails closed on Windows");
    return;
  }
  const root = await secureTemp("whoop-writable-ancestor-");
  const shared = join(root, "shared");
  const privateDirectory = join(shared, "private");
  await mkdir(shared, { mode: 0o777 });
  await chmod(shared, 0o777);
  await mkdir(privateDirectory, { mode: 0o700 });
  const store = new CredentialStore(join(privateDirectory, "credentials.json"));
  await assert.rejects(
    store.update({ accessToken: "must-not-write" }),
    /ancestors must not be writable/,
  );
});

test("CredentialStore rejects a shared parent instead of changing its permissions", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX permission checks do not apply on Windows");
    return;
  }
  const root = await secureTemp("whoop-parent-mode-");
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
  const root = await secureTemp("whoop-hardlink-");
  const target = join(root, "target.json");
  const path = join(root, "credentials.json");
  await writeFile(target, '{"accessToken":"must-not-load"}\n', { mode: 0o600 });
  await link(target, path);
  await assert.rejects(
    new CredentialStore(path).loadFile(),
    /linked/,
  );
});

test("CredentialStore rejects oversized files and fields", async () => {
  const root = await secureTemp("whoop-size-");
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
  const root = await secureTemp("whoop-shape-");
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
  const root = await secureTemp("whoop-lock-");
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

test("CredentialStore reclaims an expired lock lease without trusting its PID", async () => {
  const root = await secureTemp("whoop-dead-lock-");
  const path = join(root, "credentials.json");
  const store = new CredentialStore(path, {
    staleLockMs: 100,
    heartbeatMs: 20,
    lockTimeoutMs: 2_000,
  });
  await store.update({ accessToken: "initial" });
  await writeFile(`${path}.lock`, `${process.pid}:${"d".repeat(32)}\n`, { mode: 0o600 });
  const expired = new Date(Date.now() - 5_000);
  await utimes(`${path}.lock`, expired, expired);
  const started = Date.now();
  const result = await store.withLock(async () => "acquired");
  assert.equal(result, "acquired");
  assert.ok(Date.now() - started < 2_000);
  await assert.rejects(readFile(`${path}.lock`, "utf8"), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("CredentialStore does not reclaim a fresh lock with a partial owner token", async () => {
  const root = await secureTemp("whoop-partial-lock-");
  const path = join(root, "credentials.json");
  const store = new CredentialStore(path);
  await store.update({ accessToken: "initial" });
  const lockPath = `${path}.lock`;
  await writeFile(lockPath, `${process.pid}:partial`, { mode: 0o600 });

  let entered = false;
  const pending = store.withLock(async () => {
    entered = true;
    return "acquired";
  });
  await wait(200);
  assert.equal(entered, false);
  await rm(lockPath);
  assert.equal(await pending, "acquired");
});

test("CredentialStore heartbeat keeps a live lease from being reclaimed", async () => {
  const root = await secureTemp("whoop-live-lease-");
  const path = join(root, "credentials.json");
  const options = {
    staleLockMs: 80,
    heartbeatMs: 10,
    lockTimeoutMs: 100,
    lockWaitMs: 10,
  };
  const owner = new CredentialStore(path, options);
  const contender = new CredentialStore(path, options);
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const holding = owner.withLock(async () => {
    signalEntered();
    await wait(300);
  });
  await entered;
  await wait(120);
  await assert.rejects(contender.withLock(async () => "stolen"), /Timed out waiting/);
  await holding;
  await assert.rejects(readFile(`${path}.lock`, "utf8"), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("CredentialStore never deletes a replacement lock it does not own", async () => {
  const root = await secureTemp("whoop-replaced-lease-");
  const path = join(root, "credentials.json");
  const lockPath = `${path}.lock`;
  const store = new CredentialStore(path);
  const replacement = `lease-v1:${"b".repeat(64)}\n`;
  await store.withLock(async () => {
    await rm(lockPath);
    await writeFile(lockPath, replacement, { mode: 0o600 });
  });
  assert.equal(await readFile(lockPath, "utf8"), replacement);
  await rm(lockPath);
});

test("persisted rotated credentials take precedence over bootstrap environment values", async () => {
  const root = await secureTemp("whoop-env-value-");
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

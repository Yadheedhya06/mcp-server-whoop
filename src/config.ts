import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

export interface Credentials {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

export interface CredentialStoreOptions {
  lockWaitMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  heartbeatMs?: number;
}

const credentialKeys = new Set<keyof Credentials>([
  "clientId",
  "clientSecret",
  "redirectUri",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "tokenType",
  "scope",
]);
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_FIELD_BYTES = 16 * 1024;
const DEFAULT_LOCK_WAIT_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const currentUid = process.platform === "win32" ? undefined : process.getuid?.();
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type OpenHandle = Awaited<ReturnType<typeof open>>;

function isCredentials(value: unknown): value is Credentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      credentialKeys.has(key as keyof Credentials) &&
      (entry === undefined ||
        (typeof entry === "string" &&
          !entry.includes("\0") &&
          Buffer.byteLength(entry, "utf8") <= MAX_CREDENTIAL_FIELD_BYTES)),
  );
}

function fileError(action: "read" | "update", error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("WHOOP credential")) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  return new Error(`Unable to ${action} WHOOP credential file${code ? ` (${code})` : ""}`);
}

function positiveOption(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0 || selected > 3_600_000) {
    throw new Error(`Invalid ${label} credential-lock option`);
  }
  return selected;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathSegments(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const rest = relative(root, absolute).split(sep).filter(Boolean);
  const segments = [root];
  let current = root;
  for (const part of rest) {
    current = join(current, part);
    segments.push(current);
  }
  return segments;
}

function assertPosixPersistence(): void {
  if (process.platform === "win32") {
    throw new Error(
      "WHOOP credential persistence is disabled on native Windows because Node file modes do not enforce private ACLs and do not provide reparse-safe opens. Use a short-lived WHOOP_ACCESS_TOKEN environment value, or run this package in WSL/Linux/macOS.",
    );
  }
  if (currentUid === undefined || !constants.O_NOFOLLOW) {
    throw new Error("WHOOP credential persistence requires POSIX ownership checks and O_NOFOLLOW support");
  }
}

export function defaultCredentialsPath(): string {
  if (process.env.WHOOP_CREDENTIALS_FILE) {
    return resolve(process.env.WHOOP_CREDENTIALS_FILE);
  }
  const configHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return resolve(configHome, "mcp-server-whoop", "credentials.json");
}

function fromEnvironment(): Credentials {
  return {
    clientId: process.env.WHOOP_CLIENT_ID,
    clientSecret: process.env.WHOOP_CLIENT_SECRET,
    redirectUri: process.env.WHOOP_REDIRECT_URI,
    accessToken: process.env.WHOOP_ACCESS_TOKEN,
    refreshToken: process.env.WHOOP_REFRESH_TOKEN,
    expiresAt: process.env.WHOOP_TOKEN_EXPIRES_AT,
  };
}

function defined(input: Credentials): Credentials {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => Boolean(value)),
  ) as Credentials;
}

export class CredentialStore {
  readonly path: string;
  private readonly lockPath: string;
  private readonly lockWaitMs: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly heartbeatMs: number;

  constructor(path = defaultCredentialsPath(), options: CredentialStoreOptions = {}) {
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
    this.lockWaitMs = positiveOption(options.lockWaitMs, DEFAULT_LOCK_WAIT_MS, "wait");
    this.lockTimeoutMs = positiveOption(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "timeout");
    this.staleLockMs = positiveOption(options.staleLockMs, DEFAULT_STALE_LOCK_MS, "stale lease");
    this.heartbeatMs = positiveOption(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, "heartbeat");
    if (this.heartbeatMs >= this.staleLockMs) {
      throw new Error("Credential-lock heartbeat must be shorter than its stale lease");
    }
  }

  assertPersistentStorageSupported(): void {
    assertPosixPersistence();
  }

  private async inspectDirectory(path: string, directParent: boolean): Promise<Stats> {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("WHOOP credential path ancestors must be real directories, not symlinks");
    }
    if (currentUid === undefined) {
      throw new Error("WHOOP credential persistence requires current-user ownership checks");
    }
    if (directParent) {
      if (metadata.uid !== currentUid) {
        throw new Error("WHOOP credential parent directory must be owned by the current user");
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error("WHOOP credential parent directory must not be accessible by group or other users");
      }
      return metadata;
    }

    if (metadata.uid !== currentUid && metadata.uid !== 0) {
      throw new Error("WHOOP credential ancestors must be owned by the current user or root");
    }
    const writableByOthers = (metadata.mode & 0o022) !== 0;
    const rootOwnedStickyDirectory = metadata.uid === 0 && (metadata.mode & 0o1000) !== 0;
    if (writableByOthers && !rootOwnedStickyDirectory) {
      throw new Error("WHOOP credential ancestors must not be writable by group or other users");
    }
    return metadata;
  }

  private async ensurePrivateDirectory(): Promise<Stats> {
    assertPosixPersistence();
    const directory = dirname(this.path);
    const segments = pathSegments(directory);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      const directParent = index === segments.length - 1;
      try {
        await this.inspectDirectory(segment, directParent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await mkdir(segment, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        const created = await this.inspectDirectory(segment, directParent);
        if (created.uid !== currentUid) {
          throw new Error("WHOOP credential directory creation was redirected to another owner");
        }
        await chmod(segment, 0o700);
      }
    }
    return this.inspectDirectory(directory, true);
  }

  private async validateOpenFile(
    handle: OpenHandle,
    path: string,
    label: "credential" | "temporary credential" | "credential lock",
  ): Promise<Stats> {
    const metadata = await handle.stat();
    const pathMetadata = await lstat(path);
    if (
      !metadata.isFile() ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      !sameFile(metadata, pathMetadata) ||
      metadata.nlink !== 1
    ) {
      throw new Error(`WHOOP ${label} path changed during validation or is linked`);
    }
    if (currentUid === undefined || metadata.uid !== currentUid) {
      throw new Error(`WHOOP ${label} file must be owned by the current user`);
    }
    return metadata;
  }

  private async validateDirectoryIdentity(expected: Stats): Promise<void> {
    const current = await this.ensurePrivateDirectory();
    if (!sameFile(expected, current)) {
      throw new Error("WHOOP credential parent directory changed during the operation");
    }
  }

  async loadFile(): Promise<Credentials> {
    let handle: OpenHandle | undefined;
    try {
      await this.ensurePrivateDirectory();
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await this.validateOpenFile(handle, this.path, "credential");
      if (metadata.size > MAX_CREDENTIAL_FILE_BYTES) {
        throw new Error("WHOOP credential file exceeds the 64 KiB safety limit");
      }
      if ((metadata.mode & 0o077) !== 0) {
        await handle.chmod(0o600);
      }
      const raw = await handle.readFile("utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isCredentials(parsed)) {
        throw new Error("WHOOP credential file must contain only documented, bounded string fields");
      }
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return {};
      if (code === "ELOOP") {
        throw new Error("WHOOP credential path must be a regular file, not a symlink");
      }
      if (error instanceof SyntaxError) {
        throw new Error("WHOOP credential file contains invalid JSON");
      }
      throw fileError("read", error);
    } finally {
      await handle?.close();
    }
  }

  async load(): Promise<Credentials> {
    const environment = defined(fromEnvironment());
    if (!isCredentials(environment)) {
      throw new Error("WHOOP credential environment values exceed safety limits");
    }
    if (process.platform === "win32") {
      return environment;
    }
    const file = await this.loadFile();
    return {
      clientId: environment.clientId || file.clientId,
      clientSecret: environment.clientSecret || file.clientSecret,
      redirectUri: environment.redirectUri || file.redirectUri,
      accessToken: file.accessToken || environment.accessToken,
      refreshToken: file.refreshToken || environment.refreshToken,
      expiresAt: file.expiresAt || environment.expiresAt,
      tokenType: file.tokenType,
      scope: file.scope,
    };
  }

  async update(updates: Credentials): Promise<void> {
    let temporary: string | undefined;
    let handle: OpenHandle | undefined;
    try {
      if (!isCredentials(updates)) {
        throw new Error("WHOOP credential update contains invalid or oversized fields");
      }
      const parent = await this.ensurePrivateDirectory();
      const current = await this.loadFile();
      const next = { ...current, ...defined(updates) };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_FILE_BYTES) {
        throw new Error("WHOOP credential file exceeds the 64 KiB safety limit");
      }
      temporary = `${this.path}.${randomBytes(32).toString("hex")}.tmp`;
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await this.validateOpenFile(handle, temporary, "temporary credential");
      await handle.writeFile(serialized, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      await this.validateDirectoryIdentity(parent);
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      temporary = undefined;
      await this.validateDirectoryIdentity(parent);
      const persisted = await this.loadFile();
      if (JSON.stringify(persisted) !== JSON.stringify(next)) {
        throw new Error("WHOOP credential replacement failed post-write verification");
      }

      const directory = await open(dirname(this.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const descriptorMetadata = await directory.stat();
        if (!descriptorMetadata.isDirectory() || !sameFile(parent, descriptorMetadata)) {
          throw new Error("WHOOP credential parent directory changed before disk sync");
        }
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      throw fileError("update", error);
    } finally {
      await handle?.close();
      if (temporary) await rm(temporary, { force: true });
    }
  }

  async clear(): Promise<void> {
    this.assertPersistentStorageSupported();
    await this.withLock(async () => {
      await this.loadFile();
      await rm(this.path, { force: true });
    });
  }

  private async removeStaleLock(): Promise<boolean> {
    let lock: OpenHandle | undefined;
    try {
      lock = await open(this.lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await this.validateOpenFile(lock, this.lockPath, "credential lock");
      if (metadata.size > 256) {
        throw new Error("WHOOP credential lock contains oversized owner data");
      }
      await lock.readFile("utf8");
      if (Date.now() - metadata.mtimeMs <= this.staleLockMs) return false;
      const current = await lstat(this.lockPath);
      if (!sameFile(metadata, current)) return false;
      await rm(this.lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("WHOOP credential lock path must not be a symlink");
      }
      throw error;
    } finally {
      await lock?.close();
    }
  }

  private async releaseOwnedLock(handle: OpenHandle): Promise<void> {
    try {
      const owned = await handle.stat();
      const current = await lstat(this.lockPath);
      if (sameFile(owned, current)) {
        await rm(this.lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await handle.close();
    }
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const owner = `lease-v1:${randomBytes(32).toString("hex")}`;
    let ownedHandle: OpenHandle | undefined;
    await this.ensurePrivateDirectory();
    while (true) {
      let handle: OpenHandle | undefined;
      try {
        handle = await open(
          this.lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        await this.validateOpenFile(handle, this.lockPath, "credential lock");
        await handle.writeFile(`${owner}\n`, "utf8");
        await handle.chmod(0o600);
        await handle.sync();
        ownedHandle = handle;
        handle = undefined;
        break;
      } catch (error) {
        await handle?.close();
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.removeStaleLock()) continue;
        if (Date.now() - started > this.lockTimeoutMs) {
          throw new Error("Timed out waiting for WHOOP credential refresh lock");
        }
        await wait(this.lockWaitMs);
      }
    }

    const heartbeat = setInterval(() => {
      if (!ownedHandle) return;
      const now = new Date();
      void ownedHandle.utimes(now, now).catch(() => {});
    }, this.heartbeatMs);
    heartbeat.unref();

    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      if (ownedHandle) await this.releaseOwnedLock(ownedHandle);
    }
  }
}

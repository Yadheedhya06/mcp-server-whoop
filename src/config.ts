import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const currentUid = process.platform === "win32" ? undefined : process.getuid?.();
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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

export function defaultCredentialsPath(): string {
  if (process.env.WHOOP_CREDENTIALS_FILE) {
    return process.env.WHOOP_CREDENTIALS_FILE;
  }
  const configHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "mcp-server-whoop", "credentials.json");
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

  constructor(path = defaultCredentialsPath()) {
    this.path = path;
    this.lockPath = `${path}.lock`;
  }

  private async ensurePrivateDirectory(): Promise<void> {
    const directory = dirname(this.path);
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("WHOOP credential parent must be a regular directory, not a symlink");
      }
      if (currentUid !== undefined && metadata.uid !== currentUid) {
        throw new Error("WHOOP credential parent directory must be owned by the current user");
      }
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new Error("WHOOP credential parent directory must not be accessible by group or other users");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("WHOOP credential parent must be a regular directory, not a symlink");
      }
      if (currentUid !== undefined && metadata.uid !== currentUid) {
        throw new Error("WHOOP credential parent directory must be owned by the current user");
      }
      if (process.platform !== "win32") await chmod(directory, 0o700);
    }
  }

  async loadFile(): Promise<Credentials> {
    let handle;
    try {
      await this.ensurePrivateDirectory();
      handle = await open(this.path, constants.O_RDONLY | NO_FOLLOW);
      const metadata = await handle.stat();
      const pathMetadata = await lstat(this.path);
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
        throw new Error("WHOOP credential path must be a regular file, not a symlink");
      }
      if (!metadata.isFile()) {
        throw new Error("WHOOP credential path must be a regular file, not a symlink");
      }
      if (
        metadata.dev !== pathMetadata.dev ||
        metadata.ino !== pathMetadata.ino ||
        metadata.nlink !== 1
      ) {
        throw new Error("WHOOP credential path changed during validation or has multiple links");
      }
      if (currentUid !== undefined && metadata.uid !== currentUid) {
        throw new Error("WHOOP credential file must be owned by the current user");
      }
      if (metadata.size > MAX_CREDENTIAL_FILE_BYTES) {
        throw new Error("WHOOP credential file exceeds the 64 KiB safety limit");
      }
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
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
    const file = await this.loadFile();
    const environment = defined(fromEnvironment());
    if (!isCredentials(environment)) {
      throw new Error("WHOOP credential environment values exceed safety limits");
    }
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
    let handle;
    try {
      if (!isCredentials(updates)) {
        throw new Error("WHOOP credential update contains invalid or oversized fields");
      }
      await this.ensurePrivateDirectory();
      const current = await this.loadFile();
      const next = { ...current, ...defined(updates) };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_FILE_BYTES) {
        throw new Error("WHOOP credential file exceeds the 64 KiB safety limit");
      }
      temporary = `${this.path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      temporary = undefined;
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.path), constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      throw fileError("update", error);
    } finally {
      await handle?.close();
      if (temporary) await rm(temporary, { force: true });
    }
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await rm(this.path, { force: true });
    });
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const owner = `${process.pid}:${randomBytes(16).toString("hex")}`;
    let ownedHandle: Awaited<ReturnType<typeof open>> | undefined;
    await this.ensurePrivateDirectory();
    while (true) {
      let handle;
      try {
        handle = await open(
          this.lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
          0o600,
        );
        await handle.writeFile(`${owner}\n`, "utf8");
        await handle.sync();
        ownedHandle = handle;
        handle = undefined;
        break;
      } catch (error) {
        await handle?.close();
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lock = await open(this.lockPath, constants.O_RDONLY | NO_FOLLOW);
          let metadata;
          let currentOwner = "";
          try {
            metadata = await lock.stat();
            if (metadata.size <= 256) currentOwner = (await lock.readFile("utf8")).trim();
          } finally {
            await lock.close();
          }
          const age = Date.now() - metadata.mtimeMs;
          const ownerMatch = currentOwner.match(/^([1-9][0-9]{0,14}):[a-f0-9]{32}$/);
          const ownerPid = ownerMatch ? Number(ownerMatch[1]) : Number.NaN;
          let ownerAlive = false;
          if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
            try {
              process.kill(ownerPid, 0);
              ownerAlive = true;
            } catch (processError) {
              ownerAlive = (processError as NodeJS.ErrnoException).code === "EPERM";
            }
          }
          if ((ownerMatch && !ownerAlive && age >= 0) || (!ownerMatch && age > STALE_LOCK_MS)) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new Error("Timed out waiting for WHOOP credential refresh lock");
        }
        await wait(LOCK_WAIT_MS);
      }
    }

    try {
      return await operation();
    } finally {
      try {
        await ownedHandle?.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        if (ownedHandle) await rm(this.lockPath, { force: true });
      }
    }
  }
}

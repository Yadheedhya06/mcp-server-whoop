import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
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

const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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

  async loadFile(): Promise<Credentials> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as Credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid WHOOP credentials JSON at ${this.path}`);
      }
      throw error;
    }
  }

  async load(): Promise<Credentials> {
    const file = await this.loadFile();
    const environment = defined(fromEnvironment());
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
    const current = await this.loadFile();
    const next = { ...current, ...defined(updates) };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
    await rm(this.lockPath, { force: true });
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    while (true) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
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
      await rm(this.lockPath, { force: true });
    }
  }
}

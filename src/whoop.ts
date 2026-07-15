import { CredentialStore, type Credentials } from "./config.js";
import type {
  BodyMeasurement,
  CycleRecord,
  OAuthTokenResponse,
  PaginatedResponse,
  RecoveryRecord,
  SleepRecord,
  WorkoutRecord,
} from "./types.js";

const DEFAULT_API_BASE = "https://api.prod.whoop.com/developer/v2";
const DEFAULT_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_NEXT_TOKEN_BYTES = 4 * 1024;
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface WhoopClientOptions {
  store?: CredentialStore;
  apiBase?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function required(credentials: Credentials, key: keyof Credentials): string {
  const value = credentials[key];
  if (!value) {
    throw new Error(
      `Missing WHOOP ${key}. Run \"mcp-server-whoop auth\" or configure the documented environment variables.`,
    );
  }
  return value;
}

function parseExpiry(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function startDate(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function retryAfterMilliseconds(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, seconds * 1_000));
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 1_000;
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, timestamp - Date.now()));
}

function asHours(milliseconds: number | undefined): number | undefined {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.round((milliseconds / 3_600_000) * 100) / 100;
}

function asMinutes(milliseconds: number | undefined): number | undefined {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.round((milliseconds / 60_000) * 10) / 10;
}

function asKilocalories(kilojoules: number | undefined): number | undefined {
  if (typeof kilojoules !== "number" || !Number.isFinite(kilojoules) || kilojoules < 0) return undefined;
  return Math.round(kilojoules / 4.184);
}

function finiteBetween(value: number | undefined, minimum: number, maximum: number): number | undefined {
  return Number.isFinite(value) && (value as number) >= minimum && (value as number) <= maximum
    ? value
    : undefined;
}

function safeLabel(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? Array.from(cleaned).slice(0, 100).join("") : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = 16 * 1024): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum;
}

function validTimestamp(value: unknown): value is string {
  return boundedString(value, 128) && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validOffset(value: unknown): value is string {
  return boundedString(value, 16) && offsetMinutes(value) !== undefined;
}

async function readBoundedJson(response: Response, limit: number, label: string): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(`${label} exceeded the response size limit`);
  }
  if (!response.body) throw new Error(`${label} returned an empty response`);
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
        throw new Error(`${label} exceeded the response size limit`);
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
    throw new Error(`${label} returned invalid JSON`);
  }
}

function validTokenResponse(value: unknown): value is OAuthTokenResponse {
  if (!isObject(value) || !boundedString(value.access_token) || value.access_token.length === 0) return false;
  if (value.refresh_token !== undefined && !boundedString(value.refresh_token)) return false;
  if (value.token_type !== undefined && !boundedString(value.token_type, 128)) return false;
  if (value.scope !== undefined && !boundedString(value.scope, 2_048)) return false;
  const expires = value.expires_in === undefined ? 3_600 : Number(value.expires_in);
  return Number.isFinite(expires) && expires > 0 && expires <= 31_536_000;
}

function validRecovery(value: unknown): value is RecoveryRecord {
  return isObject(value) && boundedString(value.sleep_id, 512) && value.sleep_id.length > 0 && validTimestamp(value.created_at) && boundedString(value.score_state, 64);
}

function validSleep(value: unknown): value is SleepRecord {
  return isObject(value) && boundedString(value.id, 512) && value.id.length > 0 && validTimestamp(value.start) && validTimestamp(value.end) && validOffset(value.timezone_offset) && typeof value.nap === "boolean" && boundedString(value.score_state, 64);
}

function validCycle(value: unknown): value is CycleRecord {
  return isObject(value) && validTimestamp(value.start) && (value.end === undefined || value.end === null || validTimestamp(value.end)) && validOffset(value.timezone_offset) && boundedString(value.score_state, 64);
}

function validWorkout(value: unknown): value is WorkoutRecord {
  return isObject(value) && validTimestamp(value.start) && validTimestamp(value.end) && validOffset(value.timezone_offset) && boundedString(value.sport_name, 1_024) && boundedString(value.score_state, 64);
}

function scoreStatus(
  scoreState: string,
): "ready" | "processing" | "unscorable" | "unknown" {
  if (scoreState === "SCORED") return "ready";
  if (scoreState === "PENDING_SCORE") return "processing";
  if (scoreState === "UNSCORABLE") return "unscorable";
  return "unknown";
}

function offsetMinutes(offset: string): number | undefined {
  if (offset === "Z") return 0;
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const remainder = Number(match[3]);
  if (hours > 14 || remainder > 59 || (hours === 14 && remainder !== 0)) {
    return undefined;
  }
  const minutes = hours * 60 + remainder;
  return match[1] === "+" ? minutes : -minutes;
}

export function localDateTime(
  timestamp: string | undefined,
  offset: string,
): string | undefined {
  if (!timestamp) return undefined;
  const timestampMs = Date.parse(timestamp);
  const minutes = offsetMinutes(offset);
  if (!Number.isFinite(timestampMs) || minutes === undefined) return undefined;
  const local = new Date(timestampMs + minutes * 60_000);
  if (!Number.isFinite(local.getTime())) return undefined;
  const dateTime = local.toISOString().slice(0, 19).replace("T", " ");
  return `${dateTime} ${offset === "Z" ? "+00:00" : offset}`;
}

function localDate(timestamp: string, offset: string): string | undefined {
  return localDateTime(timestamp, offset)?.slice(0, 10);
}

function pickDefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export class WhoopClient {
  private readonly store: CredentialStore;
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: WhoopClientOptions = {}) {
    this.store = options.store || new CredentialStore();
    this.apiBase = options.apiBase || DEFAULT_API_BASE;
    this.tokenUrl = options.tokenUrl || DEFAULT_TOKEN_URL;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => new Date());
  }

  private tokenIsFresh(credentials: Credentials): boolean {
    if (!credentials.accessToken) return false;
    const expiry = parseExpiry(credentials.expiresAt);
    return expiry === undefined || expiry > this.now().getTime() + TOKEN_REFRESH_SKEW_MS;
  }

  private async accessToken(failedToken?: string): Promise<string> {
    const initial = await this.store.load();
    if (!failedToken && this.tokenIsFresh(initial)) {
      return required(initial, "accessToken");
    }

    return this.store.withLock(async () => {
      const credentials = await this.store.load();
      const currentToken = credentials.accessToken;
      if (failedToken && currentToken && currentToken !== failedToken) {
        return currentToken;
      }
      if (!failedToken && this.tokenIsFresh(credentials)) {
        return required(credentials, "accessToken");
      }
      if (!credentials.refreshToken) {
        throw new Error(
          "WHOOP access token is missing or expired and no refresh token is available. Run \"mcp-server-whoop auth\".",
        );
      }

      const response = await this.fetchImpl(this.tokenUrl, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "mcp-server-whoop",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: required(credentials, "clientId"),
          client_secret: required(credentials, "clientSecret"),
          scope: "offline",
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`WHOOP token refresh failed (${response.status})`);
      }
      const tokenPayload = await readBoundedJson(
        response,
        MAX_TOKEN_RESPONSE_BYTES,
        "WHOOP token refresh",
      );
      if (!validTokenResponse(tokenPayload)) {
        throw new Error("WHOOP token refresh returned an invalid token response");
      }
      const tokens = tokenPayload;
      const expiresIn = Number(tokens.expires_in ?? 3600);
      await this.store.update({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresAt: new Date(this.now().getTime() + expiresIn * 1000).toISOString(),
        tokenType: tokens.token_type || "bearer",
        scope: tokens.scope,
      });
      return tokens.access_token;
    });
  }

  private async getJson<T>(
    endpoint: string,
    parameters: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(`${this.apiBase}${endpoint}`);
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let token = await this.accessToken();
    let authenticationRetried = false;
    let rateLimitRetried = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "mcp-server-whoop",
        },
      });
      if (response.ok) {
        return (await readBoundedJson(response, MAX_API_RESPONSE_BYTES, "WHOOP API")) as T;
      }
      if (response.status === 401 && !authenticationRetried) {
        await response.body?.cancel();
        authenticationRetried = true;
        token = await this.accessToken(token);
        continue;
      }
      if (response.status === 429 && !rateLimitRetried) {
        await response.body?.cancel();
        rateLimitRetried = true;
        await wait(retryAfterMilliseconds(response));
        continue;
      }
      await response.body?.cancel();
      throw new Error(`WHOOP API failed (${response.status})`);
    }
    throw new Error("WHOOP API retry limit exceeded");
  }

  private async collection<T>(
    endpoint: string,
    days: number,
    label: string,
    validator: (value: unknown) => value is T,
  ): Promise<T[]> {
    const safeDays = Number.isFinite(days)
      ? Math.max(1, Math.min(180, Math.floor(days)))
      : 1;
    const now = this.now();
    const records: T[] = [];
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const response = await this.getJson<PaginatedResponse<unknown>>(endpoint, {
        start: startDate(now, safeDays),
        end: now.toISOString(),
        limit: 25,
        nextToken,
      });
      if (
        !isObject(response) ||
        !Array.isArray(response.records) ||
        !response.records.every(validator)
      ) {
        throw new Error(`WHOOP API returned invalid ${label} data`);
      }
      records.push(...response.records);
      if (
        response.next_token !== undefined &&
        (!boundedString(response.next_token, MAX_NEXT_TOKEN_BYTES) || !response.next_token)
      ) {
        throw new Error("WHOOP API returned an invalid pagination token");
      }
      nextToken = response.next_token as string | undefined;
      if (!nextToken) return records;
      if (seenTokens.has(nextToken)) {
        throw new Error("WHOOP API repeated a pagination token");
      }
      seenTokens.add(nextToken);
    }
    throw new Error("WHOOP pagination exceeded the 100-page safety limit");
  }

  recoveries(days: number): Promise<RecoveryRecord[]> {
    return this.collection<RecoveryRecord>("/recovery", days, "recovery", validRecovery);
  }

  sleeps(days: number): Promise<SleepRecord[]> {
    return this.collection<SleepRecord>("/activity/sleep", days, "sleep", validSleep);
  }

  cycles(days: number): Promise<CycleRecord[]> {
    return this.collection<CycleRecord>("/cycle", days, "cycle", validCycle);
  }

  workouts(days: number): Promise<WorkoutRecord[]> {
    return this.collection<WorkoutRecord>("/activity/workout", days, "workout", validWorkout);
  }

  async bodyMeasurement(): Promise<BodyMeasurement> {
    const body = await this.getJson<unknown>("/user/measurement/body");
    if (
      !isObject(body) ||
      finiteBetween(body.height_meter as number | undefined, 0.3, 3) === undefined ||
      finiteBetween(body.weight_kilogram as number | undefined, 1, 1_000) === undefined ||
      finiteBetween(body.max_heart_rate as number | undefined, 1, 300) === undefined
    ) {
      throw new Error("WHOOP API returned invalid body measurement data");
    }
    return body as unknown as BodyMeasurement;
  }
}

export function formatRecovery(record: RecoveryRecord, sleep?: SleepRecord) {
  const score = record.score;
  return pickDefined({
    date_local: sleep ? localDate(sleep.end, sleep.timezone_offset) : undefined,
    wake_time_local: sleep
      ? localDateTime(sleep.end, sleep.timezone_offset)
      : undefined,
    processing_status: scoreStatus(record.score_state),
    recovery_score_percent: finiteBetween(score?.recovery_score, 0, 100),
    hrv_rmssd_ms: finiteBetween(score?.hrv_rmssd_milli, 0, 10_000),
    resting_heart_rate_bpm: finiteBetween(score?.resting_heart_rate, 1, 300),
    spo2_percent: finiteBetween(score?.spo2_percentage, 0, 100),
    skin_temperature_celsius: finiteBetween(score?.skin_temp_celsius, 20, 50),
    user_calibrating:
      typeof score?.user_calibrating === "boolean" ? score.user_calibrating : undefined,
  });
}

export function formatSleep(record: SleepRecord) {
  const score = record.score;
  const stages = score?.stage_summary;
  const sleepParts = stages
    ? [
        stages.total_light_sleep_time_milli,
        stages.total_slow_wave_sleep_time_milli,
        stages.total_rem_sleep_time_milli,
      ]
    : undefined;
  const actualSleepMs = sleepParts?.every(
    (value) => Number.isFinite(value) && value >= 0,
  )
    ? sleepParts.reduce((total, value) => total + value, 0)
    : undefined;
  const needed = score?.sleep_needed;
  const neededParts = needed
    ? [
        needed.baseline_milli,
        needed.need_from_sleep_debt_milli,
        needed.need_from_recent_strain_milli,
        needed.need_from_recent_nap_milli,
      ]
    : undefined;
  const totalNeededMs = neededParts?.every(
    (value) => Number.isFinite(value) && value >= 0,
  )
    ? neededParts.reduce((total, value) => total + value, 0)
    : undefined;
  return pickDefined({
    activity_type: record.nap ? "nap" : "sleep",
    date_local: localDate(record.end, record.timezone_offset),
    start_local: localDateTime(record.start, record.timezone_offset),
    end_local: localDateTime(record.end, record.timezone_offset),
    processing_status: scoreStatus(record.score_state),
    actual_sleep_hours: asHours(actualSleepMs),
    time_in_bed_hours: asHours(stages?.total_in_bed_time_milli),
    awake_hours: asHours(stages?.total_awake_time_milli),
    light_sleep_hours: asHours(stages?.total_light_sleep_time_milli),
    slow_wave_sleep_hours: asHours(stages?.total_slow_wave_sleep_time_milli),
    rem_sleep_hours: asHours(stages?.total_rem_sleep_time_milli),
    sleep_performance_percent: finiteBetween(score?.sleep_performance_percentage, 0, 100),
    sleep_efficiency_percent: finiteBetween(score?.sleep_efficiency_percentage, 0, 100),
    sleep_consistency_percent: finiteBetween(score?.sleep_consistency_percentage, 0, 100),
    respiratory_rate: finiteBetween(score?.respiratory_rate, 1, 100),
    disturbances: finiteBetween(stages?.disturbance_count, 0, 10_000),
    sleep_cycles: finiteBetween(stages?.sleep_cycle_count, 0, 1_000),
    sleep_needed_hours: asHours(totalNeededMs),
  });
}

export function formatCycle(record: CycleRecord) {
  const score = record.score;
  return pickDefined({
    activity_type: "physiological_cycle",
    date_local: localDate(record.start, record.timezone_offset),
    start_local: localDateTime(record.start, record.timezone_offset),
    end_local: localDateTime(record.end, record.timezone_offset),
    processing_status: scoreStatus(record.score_state),
    strain: finiteBetween(score?.strain, 0, 21),
    calories_kcal: asKilocalories(score?.kilojoule),
    average_heart_rate_bpm: finiteBetween(score?.average_heart_rate, 1, 300),
    max_heart_rate_bpm: finiteBetween(score?.max_heart_rate, 1, 300),
    is_current_cycle: !record.end,
  });
}

export function formatWorkout(record: WorkoutRecord) {
  const score = record.score;
  const parsedDuration = Date.parse(record.end) - Date.parse(record.start);
  const durationMs = Number.isFinite(parsedDuration) && parsedDuration >= 0
    ? parsedDuration
    : undefined;
  const zones = score?.zone_durations;
  const zoneMinutes = zones
    ? pickDefined({
        zone_0: asMinutes(zones.zone_zero_milli),
        zone_1: asMinutes(zones.zone_one_milli),
        zone_2: asMinutes(zones.zone_two_milli),
        zone_3: asMinutes(zones.zone_three_milli),
        zone_4: asMinutes(zones.zone_four_milli),
        zone_5: asMinutes(zones.zone_five_milli),
      })
    : undefined;
  return pickDefined({
    activity_type: "workout",
    sport: safeLabel(record.sport_name),
    date_local: localDate(record.start, record.timezone_offset),
    start_local: localDateTime(record.start, record.timezone_offset),
    end_local: localDateTime(record.end, record.timezone_offset),
    duration_minutes: asMinutes(durationMs),
    processing_status: scoreStatus(record.score_state),
    strain: finiteBetween(score?.strain, 0, 21),
    average_heart_rate_bpm: finiteBetween(score?.average_heart_rate, 1, 300),
    max_heart_rate_bpm: finiteBetween(score?.max_heart_rate, 1, 300),
    calories_kcal: asKilocalories(score?.kilojoule),
    heart_rate_data_recorded_percent: finiteBetween(score?.percent_recorded, 0, 100),
    distance_meters: finiteBetween(score?.distance_meter, 0, 1_000_000_000),
    heart_rate_zone_minutes:
      zoneMinutes && Object.keys(zoneMinutes).length > 0 ? zoneMinutes : undefined,
  });
}

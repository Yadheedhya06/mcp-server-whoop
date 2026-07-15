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
  if (milliseconds === undefined) return undefined;
  return Math.round((milliseconds / 3_600_000) * 100) / 100;
}

function asMinutes(milliseconds: number | undefined): number | undefined {
  if (milliseconds === undefined) return undefined;
  return Math.round((milliseconds / 60_000) * 10) / 10;
}

function asKilocalories(kilojoules: number | undefined): number | undefined {
  if (kilojoules === undefined) return undefined;
  return Math.round(kilojoules / 4.184);
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
  const minutes = Number(match[2]) * 60 + Number(match[3]);
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
          "User-Agent": "mcp-server-whoop/0.1",
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
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`WHOOP token refresh failed (${response.status}): ${detail}`);
      }
      const tokens = (await response.json()) as OAuthTokenResponse;
      if (!tokens.access_token) {
        throw new Error("WHOOP token refresh returned no access token");
      }
      const expiresIn = Number(tokens.expires_in || 3600);
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
          "User-Agent": "mcp-server-whoop/0.1",
        },
      });
      if (response.ok) return (await response.json()) as T;
      if (response.status === 401 && !authenticationRetried) {
        authenticationRetried = true;
        token = await this.accessToken(token);
        continue;
      }
      if (response.status === 429 && !rateLimitRetried) {
        rateLimitRetried = true;
        await wait(retryAfterMilliseconds(response));
        continue;
      }
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`WHOOP API failed (${response.status}): ${detail}`);
    }
    throw new Error("WHOOP API retry limit exceeded");
  }

  private async collection<T>(endpoint: string, days: number): Promise<T[]> {
    const safeDays = Math.max(1, Math.min(180, Math.floor(days)));
    const now = this.now();
    const records: T[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.getJson<PaginatedResponse<T>>(endpoint, {
        start: startDate(now, safeDays),
        end: now.toISOString(),
        limit: 25,
        nextToken,
      });
      records.push(...(response.records || []));
      nextToken = response.next_token;
      if (!nextToken) return records;
    }
    throw new Error("WHOOP pagination exceeded the 100-page safety limit");
  }

  recoveries(days: number): Promise<RecoveryRecord[]> {
    return this.collection<RecoveryRecord>("/recovery", days);
  }

  sleeps(days: number): Promise<SleepRecord[]> {
    return this.collection<SleepRecord>("/activity/sleep", days);
  }

  cycles(days: number): Promise<CycleRecord[]> {
    return this.collection<CycleRecord>("/cycle", days);
  }

  workouts(days: number): Promise<WorkoutRecord[]> {
    return this.collection<WorkoutRecord>("/activity/workout", days);
  }

  bodyMeasurement(): Promise<BodyMeasurement> {
    return this.getJson<BodyMeasurement>("/user/measurement/body");
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
    recovery_score_percent: score?.recovery_score,
    hrv_rmssd_ms: score?.hrv_rmssd_milli,
    resting_heart_rate_bpm: score?.resting_heart_rate,
    spo2_percent: score?.spo2_percentage,
    skin_temperature_celsius: score?.skin_temp_celsius,
    user_calibrating: score?.user_calibrating,
  });
}

export function formatSleep(record: SleepRecord) {
  const score = record.score;
  const stages = score?.stage_summary;
  const actualSleepMs = stages
    ? stages.total_light_sleep_time_milli +
      stages.total_slow_wave_sleep_time_milli +
      stages.total_rem_sleep_time_milli
    : undefined;
  const needed = score?.sleep_needed;
  const totalNeededMs = needed
    ? needed.baseline_milli +
      needed.need_from_sleep_debt_milli +
      needed.need_from_recent_strain_milli +
      needed.need_from_recent_nap_milli
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
    sleep_performance_percent: score?.sleep_performance_percentage,
    sleep_efficiency_percent: score?.sleep_efficiency_percentage,
    sleep_consistency_percent: score?.sleep_consistency_percentage,
    respiratory_rate: score?.respiratory_rate,
    disturbances: stages?.disturbance_count,
    sleep_cycles: stages?.sleep_cycle_count,
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
    strain: score?.strain,
    calories_kcal: asKilocalories(score?.kilojoule),
    average_heart_rate_bpm: score?.average_heart_rate,
    max_heart_rate_bpm: score?.max_heart_rate,
    is_current_cycle: !record.end,
  });
}

export function formatWorkout(record: WorkoutRecord) {
  const score = record.score;
  const durationMs = Math.max(0, Date.parse(record.end) - Date.parse(record.start));
  const zones = score?.zone_durations;
  return pickDefined({
    activity_type: "workout",
    sport: record.sport_name,
    date_local: localDate(record.start, record.timezone_offset),
    start_local: localDateTime(record.start, record.timezone_offset),
    end_local: localDateTime(record.end, record.timezone_offset),
    duration_minutes: asMinutes(durationMs),
    processing_status: scoreStatus(record.score_state),
    strain: score?.strain,
    average_heart_rate_bpm: score?.average_heart_rate,
    max_heart_rate_bpm: score?.max_heart_rate,
    calories_kcal: asKilocalories(score?.kilojoule),
    heart_rate_data_recorded_percent: score?.percent_recorded,
    distance_meters: score?.distance_meter,
    heart_rate_zone_minutes: zones
      ? {
          zone_0: asMinutes(zones.zone_zero_milli),
          zone_1: asMinutes(zones.zone_one_milli),
          zone_2: asMinutes(zones.zone_two_milli),
          zone_3: asMinutes(zones.zone_three_milli),
          zone_4: asMinutes(zones.zone_four_milli),
          zone_5: asMinutes(zones.zone_five_milli),
        }
      : undefined,
  });
}

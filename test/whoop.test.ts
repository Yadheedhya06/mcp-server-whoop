import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/config.js";
import {
  WhoopClient,
  formatCycle,
  formatRecovery,
  formatSleep,
  formatWorkout,
  localDateTime,
} from "../src/whoop.js";
import type {
  CycleRecord,
  RecoveryRecord,
  SleepRecord,
  WorkoutRecord,
} from "../src/types.js";

const secureTemp = async (prefix: string) =>
  realpath(await mkdtemp(join(tmpdir(), prefix)));
const fixedNow = new Date("2026-07-15T09:00:00.000Z");

test("formatSleep returns local signal fields without UTC or raw identifiers", () => {
  const sleep: SleepRecord = {
    id: "private-id",
    cycle_id: 1,
    created_at: fixedNow.toISOString(),
    updated_at: fixedNow.toISOString(),
    start: "2026-07-14T22:00:00.000Z",
    end: "2026-07-15T06:00:00.000Z",
    timezone_offset: "+04:00",
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: 8 * 3_600_000,
        total_awake_time_milli: 30 * 60_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 4 * 3_600_000,
        total_slow_wave_sleep_time_milli: 1.5 * 3_600_000,
        total_rem_sleep_time_milli: 2 * 3_600_000,
        sleep_cycle_count: 4,
        disturbance_count: 7,
      },
      sleep_needed: {
        baseline_milli: 8 * 3_600_000,
        need_from_sleep_debt_milli: 30 * 60_000,
        need_from_recent_strain_milli: 0,
        need_from_recent_nap_milli: 0,
      },
      sleep_performance_percentage: 90,
    },
  };
  const formatted = formatSleep(sleep);
  assert.equal(formatted.start_local, "2026-07-15 02:00:00 +04:00");
  assert.equal(formatted.end_local, "2026-07-15 10:00:00 +04:00");
  assert.equal(formatted.actual_sleep_hours, 7.5);
  assert.equal(formatted.activity_type, "sleep");
  assert.equal("start" in formatted, false);
  assert.equal("sleep_id" in formatted, false);
  assert.doesNotMatch(JSON.stringify(formatted), /private-id|T\d{2}:\d{2}.*Z/);
});

test("WhoopClient refreshes and atomically persists WHOOP token rotation", async () => {
  const root = await secureTemp("whoop-refresh-");
  const store = new CredentialStore(join(root, "credentials.json"));
  await store.update({
    clientId: "client-test",
    clientSecret: "secret-test",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: "2026-07-15T08:00:00.000Z",
  });
  const requests: Array<{ url: string; authorization?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      authorization: new Headers(init?.headers).get("authorization") || undefined,
    });
    if (url.includes("/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
          token_type: "bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ records: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = new WhoopClient({
    store,
    fetchImpl,
    now: () => fixedNow,
    tokenUrl: "https://example.test/token",
    apiBase: "https://example.test/api",
  });
  assert.deepEqual(await client.recoveries(3), []);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].authorization, "Bearer access-new");
  const persisted = await store.loadFile();
  assert.equal(persisted.accessToken, "access-new");
  assert.equal(persisted.refreshToken, "refresh-new");
});

test("localDateTime uses each record offset and rejects malformed or impossible offsets", () => {
  assert.equal(
    localDateTime("2026-07-06T21:38:26.000Z", "+05:30"),
    "2026-07-07 03:08:26 +05:30",
  );
  assert.equal(
    localDateTime("2026-07-07T14:02:22.000Z", "+04:00"),
    "2026-07-07 18:02:22 +04:00",
  );
  for (const offset of ["+99:99", "+14:30", "+10:60", "UTC", "04:00"]) {
    assert.equal(localDateTime("2026-07-07T14:02:22.000Z", offset), undefined);
  }
});

test("pending sleep is explicit and never contains fabricated score values", () => {
  const pending: SleepRecord = {
    id: "pending-private-id",
    cycle_id: 2,
    created_at: fixedNow.toISOString(),
    updated_at: fixedNow.toISOString(),
    start: "2026-07-15T04:00:00.000Z",
    end: "2026-07-15T08:00:00.000Z",
    timezone_offset: "+04:00",
    nap: false,
    score_state: "PENDING_SCORE",
    score: {
      stage_summary: {
        total_in_bed_time_milli: 4 * 3_600_000,
        total_awake_time_milli: 30 * 60_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 2 * 3_600_000,
        total_slow_wave_sleep_time_milli: 45 * 60_000,
        total_rem_sleep_time_milli: 45 * 60_000,
        sleep_cycle_count: 2,
        disturbance_count: 3,
      },
      sleep_needed: {
        baseline_milli: 8 * 3_600_000,
        need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0,
        need_from_recent_nap_milli: 0,
      },
      sleep_performance_percentage: 44,
      sleep_efficiency_percentage: 88,
      sleep_consistency_percentage: 77,
      respiratory_rate: 16,
    },
  };
  const formatted = formatSleep(pending);
  assert.equal(formatted.processing_status, "processing");
  for (const field of [
    "actual_sleep_hours",
    "time_in_bed_hours",
    "awake_hours",
    "light_sleep_hours",
    "slow_wave_sleep_hours",
    "rem_sleep_hours",
    "sleep_performance_percent",
    "sleep_efficiency_percent",
    "sleep_consistency_percent",
    "respiratory_rate",
    "disturbances",
    "sleep_cycles",
    "sleep_needed_hours",
  ]) {
    assert.equal(field in formatted, false, `${field} must be excluded while pending`);
  }
  assert.doesNotMatch(JSON.stringify(formatted), /pending-private-id/);
});

test("non-SCORED records never expose finalized score-derived metrics", () => {
  const states = ["PENDING_SCORE", "UNSCORABLE", "FUTURE_STATE"] as const;
  for (const scoreState of states) {
    const recovery: RecoveryRecord = {
      cycle_id: 2,
      sleep_id: "private-sleep-id",
      created_at: fixedNow.toISOString(),
      updated_at: fixedNow.toISOString(),
      score_state: scoreState,
      score: {
        user_calibrating: false,
        recovery_score: 77,
        resting_heart_rate: 52,
        hrv_rmssd_milli: 65,
        spo2_percentage: 98,
        skin_temp_celsius: 34,
      },
    };
    const recoveryOutput = formatRecovery(recovery);
    for (const field of [
      "recovery_score_percent",
      "hrv_rmssd_ms",
      "resting_heart_rate_bpm",
      "spo2_percent",
      "skin_temperature_celsius",
      "user_calibrating",
    ]) {
      assert.equal(field in recoveryOutput, false, `${field} must be excluded for ${scoreState}`);
    }

    const completedCycle: CycleRecord = {
      id: 2,
      created_at: fixedNow.toISOString(),
      updated_at: fixedNow.toISOString(),
      start: "2026-07-14T08:00:00.000Z",
      end: "2026-07-15T08:00:00.000Z",
      timezone_offset: "+04:00",
      score_state: scoreState,
      score: {
        strain: 18,
        kilojoule: 2_000,
        average_heart_rate: 80,
        max_heart_rate: 170,
      },
    };
    const cycleOutput = formatCycle(completedCycle);
    for (const field of [
      "strain",
      "provisional_strain",
      "calories_kcal",
      "average_heart_rate_bpm",
      "max_heart_rate_bpm",
    ]) {
      assert.equal(field in cycleOutput, false, `${field} must be excluded for ${scoreState}`);
    }

    const workout: WorkoutRecord = {
      id: "private-workout-id",
      created_at: fixedNow.toISOString(),
      updated_at: fixedNow.toISOString(),
      start: "2026-07-15T07:00:00.000Z",
      end: "2026-07-15T08:00:00.000Z",
      timezone_offset: "+04:00",
      sport_name: "Running",
      score_state: scoreState,
      score: {
        strain: 15,
        average_heart_rate: 140,
        max_heart_rate: 180,
        kilojoule: 2_000,
        percent_recorded: 90,
        distance_meter: 10_000,
        zone_durations: {
          zone_zero_milli: 0,
          zone_one_milli: 600_000,
          zone_two_milli: 600_000,
          zone_three_milli: 600_000,
          zone_four_milli: 600_000,
          zone_five_milli: 600_000,
        },
      },
    };
    const workoutOutput = formatWorkout(workout);
    assert.equal(workoutOutput.duration_minutes, 60);
    for (const field of [
      "strain",
      "average_heart_rate_bpm",
      "max_heart_rate_bpm",
      "calories_kcal",
      "heart_rate_data_recorded_percent",
      "distance_meters",
      "heart_rate_zone_minutes",
    ]) {
      assert.equal(field in workoutOutput, false, `${field} must be excluded for ${scoreState}`);
    }
  }
});

test("active pending cycle exposes only explicitly provisional strain", () => {
  const currentCycle: CycleRecord = {
    id: 3,
    created_at: fixedNow.toISOString(),
    updated_at: fixedNow.toISOString(),
    start: "2026-07-15T08:00:00.000Z",
    timezone_offset: "+04:00",
    score_state: "PENDING_SCORE",
    score: {
      strain: 20.5,
      kilojoule: 4_000,
      average_heart_rate: 90,
      max_heart_rate: 180,
    },
  };
  const formatted = formatCycle(currentCycle);
  assert.equal(formatted.processing_status, "processing");
  assert.equal(formatted.is_current_cycle, true);
  assert.equal(formatted.provisional_strain, 20.5);
  for (const field of [
    "strain",
    "calories_kcal",
    "average_heart_rate_bpm",
    "max_heart_rate_bpm",
  ]) {
    assert.equal(field in formatted, false, `${field} must not look finalized`);
  }

  const unscorable = formatCycle({ ...currentCycle, score_state: "UNSCORABLE" });
  assert.equal("provisional_strain" in unscorable, false);
});

test("WhoopClient never forwards WHOOP API response bodies into errors", async () => {
  const root = await secureTemp("whoop-api-error-");
  const store = new CredentialStore(join(root, "credentials.json"));
  await store.update({ accessToken: "access-current" });
  const client = new WhoopClient({
    store,
    now: () => fixedNow,
    apiBase: "https://example.test/api",
    fetchImpl: async () => new Response("private-health-or-token-material", { status: 500 }),
  });
  await assert.rejects(
    client.recoveries(1),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "WHOOP API failed (500)" &&
      !error.message.includes("private-health-or-token-material"),
  );
});

test("WhoopClient never forwards token endpoint response bodies into errors", async () => {
  const root = await secureTemp("whoop-token-error-");
  const store = new CredentialStore(join(root, "credentials.json"));
  await store.update({
    clientId: "client",
    clientSecret: "secret",
    accessToken: "expired-access",
    refreshToken: "refresh",
    expiresAt: "2026-07-15T08:00:00.000Z",
  });
  const client = new WhoopClient({
    store,
    now: () => fixedNow,
    tokenUrl: "https://example.test/token",
    fetchImpl: async () => new Response("sensitive-provider-detail", { status: 400 }),
  });
  await assert.rejects(
    client.recoveries(1),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "WHOOP token refresh failed (400)" &&
      !error.message.includes("sensitive-provider-detail"),
  );
});

test("WhoopClient rejects malformed records, oversized bodies, and cyclic pagination", async () => {
  for (const [name, responseFactory, pattern] of [
    [
      "shape",
      () => new Response(JSON.stringify({ records: [null] }), { status: 200 }),
      /invalid recovery data/,
    ],
    [
      "size",
      () => new Response("{}", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }),
      /response size limit/,
    ],
  ] as const) {
    const root = await secureTemp(`whoop-${name}-`);
    const store = new CredentialStore(join(root, "credentials.json"));
    await store.update({ accessToken: "access-current" });
    const client = new WhoopClient({ store, fetchImpl: async () => responseFactory() });
    await assert.rejects(client.recoveries(1), pattern);
  }

  const root = await secureTemp("whoop-cycle-page-");
  const store = new CredentialStore(join(root, "credentials.json"));
  await store.update({ accessToken: "access-current" });
  let calls = 0;
  const client = new WhoopClient({
    store,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ records: [], next_token: "repeated" }), { status: 200 });
    },
  });
  await assert.rejects(client.recoveries(1), /repeated a pagination token/);
  assert.equal(calls, 2);
});

test("WhoopClient cancels a rejected response, rotates once, and retries with the new token", async () => {
  const root = await secureTemp("whoop-401-");
  const store = new CredentialStore(join(root, "credentials.json"));
  await store.update({
    clientId: "client",
    clientSecret: "secret",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: "2026-07-15T10:00:00.000Z",
  });
  let apiCalls = 0;
  let bodyCancelled = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).includes("/token")) {
      return new Response(JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new" }));
    }
    apiCalls += 1;
    if (apiCalls === 1) {
      return new Response(
        new ReadableStream({
          pull() {},
          cancel() {
            bodyCancelled = true;
          },
        }),
        { status: 401 },
      );
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-new");
    return new Response(JSON.stringify({ records: [] }));
  };
  const client = new WhoopClient({
    store,
    fetchImpl,
    now: () => fixedNow,
    tokenUrl: "https://example.test/token",
    apiBase: "https://example.test/api",
  });
  assert.deepEqual(await client.recoveries(1), []);
  assert.equal(apiCalls, 2);
  assert.equal(bodyCancelled, true);
  assert.equal((await store.loadFile()).refreshToken, "refresh-new");
});

test("WhoopClient rejects malformed refresh responses before persisting them", async () => {
  const root = await secureTemp("whoop-bad-refresh-");
  const store = new CredentialStore(join(root, "credentials.json"));
  await store.update({
    clientId: "client",
    clientSecret: "secret",
    accessToken: "expired-access",
    refreshToken: "refresh-old",
    expiresAt: "2026-07-15T08:00:00.000Z",
  });
  const client = new WhoopClient({
    store,
    fetchImpl: async () => new Response(JSON.stringify({ access_token: { nested: "bad" } })),
    tokenUrl: "https://example.test/token",
  });
  await assert.rejects(client.recoveries(1), /invalid token response/);
  assert.equal((await store.loadFile()).accessToken, "expired-access");
  assert.equal((await store.loadFile()).refreshToken, "refresh-old");
});

test("formatWorkout strips control characters and excludes impossible health values", () => {
  const workout: WorkoutRecord = {
    id: "private-workout-id",
    created_at: fixedNow.toISOString(),
    updated_at: fixedNow.toISOString(),
    start: "not-a-date",
    end: "also-not-a-date",
    timezone_offset: "+04:00",
    sport_name: "Strength\nTrainer\u0000",
    score_state: "SCORED",
    score: {
      strain: 99,
      average_heart_rate: -5,
      max_heart_rate: 999,
      kilojoule: -1,
      percent_recorded: 101,
      distance_meter: -4,
      zone_durations: {
        zone_zero_milli: -1,
        zone_one_milli: -1,
        zone_two_milli: -1,
        zone_three_milli: -1,
        zone_four_milli: -1,
        zone_five_milli: -1,
      },
    },
  };
  const formatted = formatWorkout(workout);
  assert.equal(formatted.sport, "Strength Trainer");
  for (const field of [
    "date_local",
    "start_local",
    "end_local",
    "duration_minutes",
    "strain",
    "average_heart_rate_bpm",
    "max_heart_rate_bpm",
    "calories_kcal",
    "heart_rate_data_recorded_percent",
    "distance_meters",
    "heart_rate_zone_minutes",
  ]) {
    assert.equal(field in formatted, false, `${field} must be excluded`);
  }
  assert.doesNotMatch(JSON.stringify(formatted), /private-workout-id|NaN|null/);
});

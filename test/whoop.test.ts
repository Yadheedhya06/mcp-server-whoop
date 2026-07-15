import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/config.js";
import { WhoopClient, formatSleep } from "../src/whoop.js";
import type { SleepRecord } from "../src/types.js";

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
  const root = await mkdtemp(join(tmpdir(), "whoop-refresh-"));
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

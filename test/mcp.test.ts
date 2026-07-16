import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhoopServer } from "../src/server.js";
import type { WhoopClient } from "../src/whoop.js";

const oldSleep = {
  id: "sleep-old",
  cycle_id: 1,
  created_at: "2026-07-14T06:00:00.000Z",
  updated_at: "2026-07-14T06:00:00.000Z",
  start: "2026-07-13T22:00:00.000Z",
  end: "2026-07-14T06:00:00.000Z",
  timezone_offset: "+04:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 28_800_000,
      total_awake_time_milli: 1_800_000,
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 14_400_000,
      total_slow_wave_sleep_time_milli: 5_400_000,
      total_rem_sleep_time_milli: 7_200_000,
      sleep_cycle_count: 4,
      disturbance_count: 8,
    },
    sleep_needed: {
      baseline_milli: 28_800_000,
      need_from_sleep_debt_milli: 0,
      need_from_recent_strain_milli: 0,
      need_from_recent_nap_milli: 0,
    },
  },
};
const pendingSleep = {
  ...oldSleep,
  id: "sleep-new",
  cycle_id: 2,
  start: "2026-07-14T22:00:00.000Z",
  end: "2026-07-15T06:00:00.000Z",
  score_state: "PENDING_SCORE",
  score: oldSleep.score,
};
const fakeWhoop = {
  recoveries: async () => [
    {
      cycle_id: 2,
      sleep_id: "sleep-new",
      created_at: "2026-07-15T06:05:00.000Z",
      updated_at: "2026-07-15T06:05:00.000Z",
      score_state: "PENDING_SCORE",
      score: {
        user_calibrating: false,
        recovery_score: 77,
        resting_heart_rate: 52,
        hrv_rmssd_milli: 65,
      },
    },
    {
      cycle_id: 1,
      sleep_id: "sleep-old",
      created_at: "2026-07-14T06:05:00.000Z",
      updated_at: "2026-07-14T06:05:00.000Z",
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 88,
        resting_heart_rate: 50,
        hrv_rmssd_milli: 70,
      },
    },
  ],
  sleeps: async () => [pendingSleep, oldSleep],
  cycles: async () => [
    {
      id: 2,
      created_at: "2026-07-15T06:00:00.000Z",
      updated_at: "2026-07-15T09:00:00.000Z",
      start: "2026-07-15T06:00:00.000Z",
      timezone_offset: "+04:00",
      score_state: "PENDING_SCORE",
      score: {
        strain: 20.5,
        kilojoule: 2_000,
        average_heart_rate: 90,
        max_heart_rate: 170,
      },
    },
  ],
  workouts: async () => [
    {
      id: "workout-new",
      created_at: "2026-07-15T08:00:00.000Z",
      updated_at: "2026-07-15T09:00:00.000Z",
      start: "2026-07-15T07:00:00.000Z",
      end: "2026-07-15T08:00:00.000Z",
      timezone_offset: "+04:00",
      sport_name: "Running",
      score_state: "UNSCORABLE",
      score: {
        strain: 15,
        average_heart_rate: 140,
        max_heart_rate: 180,
        kilojoule: 2_000,
        percent_recorded: 90,
        zone_durations: {
          zone_zero_milli: 0,
          zone_one_milli: 600_000,
          zone_two_milli: 600_000,
          zone_three_milli: 600_000,
          zone_four_milli: 600_000,
          zone_five_milli: 600_000,
        },
      },
    },
  ],
  bodyMeasurement: async () => ({
    height_meter: 1.8,
    weight_kilogram: 80,
    max_heart_rate: 190,
  }),
} as unknown as WhoopClient;

test("MCP exposes five read-only tools and blocks stale recovery substitution", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWhoopServer(fakeWhoop);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "whoop_cycle_strain_history",
      "whoop_latest_overview",
      "whoop_recovery_history",
      "whoop_sleep_history",
      "whoop_workout_history",
    ],
  );
  assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint));
  assert.ok(listed.tools.every((tool) => tool.annotations?.destructiveHint === false));
  assert.ok(listed.tools.every((tool) => tool.annotations?.idempotentHint));
  assert.ok(listed.tools.every((tool) => tool.annotations?.openWorldHint));

  const response = await client.callTool({
    name: "whoop_latest_overview",
    arguments: {},
  });
  const payload = response.structuredContent as Record<string, any>;
  assert.equal(payload.status.state, "waiting_for_whoop");
  assert.equal(payload.status.current_recovery_available, false);
  assert.equal(payload.recovery, null);
  assert.equal(payload.sleep.processing_status, "processing");
  assert.equal("actual_sleep_hours" in payload.sleep, false);
  assert.equal(payload.current_cycle.provisional_strain, 20.5);
  assert.equal("strain" in payload.current_cycle, false);
  assert.equal("calories_kcal" in payload.current_cycle, false);
  assert.equal(payload.latest_workout.processing_status, "unscorable");
  assert.equal("strain" in payload.latest_workout, false);
  assert.doesNotMatch(JSON.stringify(payload), /sleep-old|sleep-new|T\d{2}:\d{2}.*Z/);

  for (const [tool, forbiddenFields] of [
    [
      "whoop_recovery_history",
      ["recovery_score_percent", "hrv_rmssd_ms", "resting_heart_rate_bpm"],
    ],
    [
      "whoop_sleep_history",
      ["actual_sleep_hours", "sleep_performance_percent", "sleep_cycles"],
    ],
    [
      "whoop_cycle_strain_history",
      ["strain", "calories_kcal", "average_heart_rate_bpm"],
    ],
    [
      "whoop_workout_history",
      ["strain", "calories_kcal", "heart_rate_zone_minutes"],
    ],
  ] as const) {
    const history = await client.callTool({ name: tool, arguments: { days: 7 } });
    const historyPayload = history.structuredContent as Record<string, any>;
    const records = historyPayload.records as Array<Record<string, unknown>>;
    const newest = records[0];
    for (const field of forbiddenFields) {
      assert.equal(field in newest, false, `${tool} must exclude ${field}`);
    }
    if (tool === "whoop_cycle_strain_history") {
      assert.equal(newest.provisional_strain, 20.5);
    }
    if (tool === "whoop_recovery_history") {
      assert.equal(records[1].recovery_score_percent, 88);
    }
  }

  await client.close();
  await server.close();
});

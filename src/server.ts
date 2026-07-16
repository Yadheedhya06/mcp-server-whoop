import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  WhoopClient,
  formatCycle,
  formatRecovery,
  formatSleep,
  formatWorkout,
} from "./whoop.js";
import type {
  CycleRecord,
  RecoveryRecord,
  SleepRecord,
  WorkoutRecord,
} from "./types.js";

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
const recordSchema = z.record(z.string(), z.unknown());
const rangeInput = {
  days: z
    .number()
    .int()
    .min(1)
    .max(180)
    .default(7)
    .describe("Number of recent days to fetch, from 1 to 180"),
};
const listOutput = {
  window_days: z.number(),
  count: z.number(),
  records: z.array(recordSchema),
};
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function descending<T>(records: T[], timestamp: (record: T) => string): T[] {
  return [...records].sort(
    (left, right) =>
      Date.parse(timestamp(right)) - Date.parse(timestamp(left)),
  );
}

function result(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function recentActivities(sleeps: SleepRecord[], workouts: WorkoutRecord[]) {
  const sleepActivities = sleeps.map((sleep) => {
    const formatted = formatSleep(sleep);
    return {
      sortTime: sleep.start,
      value: {
        activity_type: formatted.activity_type,
        start_local: formatted.start_local,
        end_local: formatted.end_local,
        processing_status: formatted.processing_status,
      },
    };
  });
  const workoutActivities = workouts.map((workout) => {
    const formatted = formatWorkout(workout);
    return {
      sortTime: workout.start,
      value: {
        activity_type: formatted.activity_type,
        sport: formatted.sport,
        start_local: formatted.start_local,
        end_local: formatted.end_local,
        processing_status: formatted.processing_status,
      },
    };
  });
  return [...sleepActivities, ...workoutActivities]
    .sort((left, right) => Date.parse(right.sortTime) - Date.parse(left.sortTime))
    .slice(0, 5)
    .map(({ value }) => value);
}

export function createWhoopServer(client = new WhoopClient()): McpServer {
  const server = new McpServer(
    { name: "mcp-server-whoop", version: packageVersion },
    {
      instructions:
        "Read-only access to the user's live WHOOP data. Timestamps are already converted using each record's local offset; never convert them again. Treat processing data as unfinished and never substitute an older recovery for the newest sleep. Activity types identify sleep, nap, and workout sport, but WHOOP does not reveal whether an activity was auto-detected or manually started. Actual sleep is light + slow-wave + REM, not time in bed. Use these signals as coaching context, not medical diagnosis.",
    },
  );

  server.registerTool(
    "whoop_latest_overview",
    {
      title: "Get latest WHOOP overview",
      description:
        "Compact local-time coaching overview with newest sleep status, matching current recovery only when ready, finalized strain or explicitly provisional live current-cycle strain, latest workout, recent activity types, and body measurement.",
      inputSchema: {},
      outputSchema: {
        status: recordSchema,
        sleep: recordSchema.nullable(),
        recovery: recordSchema.nullable(),
        current_cycle: recordSchema.nullable(),
        latest_workout: recordSchema.nullable(),
        recent_activities: z.array(recordSchema),
        body_measurement: recordSchema,
      },
      annotations: readOnlyAnnotations,
    },
    async () => {
      const [recoveries, sleeps, cycles, workouts, body] = await Promise.all([
        client.recoveries(3),
        client.sleeps(3),
        client.cycles(3),
        client.workouts(3),
        client.bodyMeasurement(),
      ]);
      const primarySleeps = descending(
        sleeps.filter((sleep) => !sleep.nap),
        (sleep) => sleep.start,
      );
      const latestSleep = primarySleeps[0];
      const recoveryForLatestSleep = latestSleep
        ? recoveries.find((recovery) => recovery.sleep_id === latestSleep.id)
        : undefined;
      const sortedCycles = descending(cycles, (cycle) => cycle.start);
      const currentCycle =
        sortedCycles.find((cycle) => !cycle.end) || sortedCycles[0];
      const latestWorkout = descending(workouts, (workout) => workout.start)[0];
      const recoveryReady =
        latestSleep?.score_state === "SCORED" &&
        recoveryForLatestSleep?.score_state === "SCORED";

      let state = "ready";
      let message = "Newest sleep and matching recovery are ready.";
      if (!latestSleep) {
        state = "no_sleep_data";
        message = "No primary sleep was found in the last 3 days.";
      } else if (latestSleep.score_state === "PENDING_SCORE") {
        state = "waiting_for_whoop";
        message =
          "WHOOP is still processing the newest sleep. Current recovery is not available yet.";
      } else if (latestSleep.score_state === "UNSCORABLE") {
        state = "sleep_unscorable";
        message = "WHOOP could not score the newest sleep.";
      } else if (!recoveryReady) {
        state = "waiting_for_recovery";
        message =
          "Sleep is ready, but its matching recovery is still unavailable.";
      }

      return result({
        status: {
          state,
          message,
          current_recovery_available: recoveryReady,
        },
        sleep: latestSleep ? formatSleep(latestSleep) : null,
        recovery:
          recoveryReady && recoveryForLatestSleep
            ? formatRecovery(recoveryForLatestSleep, latestSleep)
            : null,
        current_cycle: currentCycle ? formatCycle(currentCycle) : null,
        latest_workout: latestWorkout ? formatWorkout(latestWorkout) : null,
        recent_activities: recentActivities(sleeps, workouts),
        body_measurement: {
          height_meters: body.height_meter,
          weight_kilograms: body.weight_kilogram,
          whoop_max_heart_rate_bpm: body.max_heart_rate,
        },
      });
    },
  );

  server.registerTool(
    "whoop_recovery_history",
    {
      title: "Get WHOOP recovery history",
      description:
        "Recent recovery processing state and, only when WHOOP marks a record SCORED, recovery score, HRV, resting heart rate, SpO2, and skin temperature.",
      inputSchema: rangeInput,
      outputSchema: listOutput,
      annotations: readOnlyAnnotations,
    },
    async ({ days }) => {
      const [recoveryRecords, sleeps] = await Promise.all([
        client.recoveries(days),
        client.sleeps(Math.min(180, days + 1)),
      ]);
      const sleepsById = new Map(sleeps.map((sleep) => [sleep.id, sleep]));
      const records = descending(
        recoveryRecords,
        (record: RecoveryRecord) => record.created_at,
      ).map((record) => formatRecovery(record, sleepsById.get(record.sleep_id)));
      return result({ window_days: days, count: records.length, records });
    },
  );

  server.registerTool(
    "whoop_sleep_history",
    {
      title: "Get WHOOP sleep history",
      description:
        "Recent local bedtime/wake time, sleep or nap type, processing state, and finalized sleep metrics only when WHOOP marks a record SCORED.",
      inputSchema: {
        ...rangeInput,
        include_naps: z
          .boolean()
          .default(false)
          .describe("Include naps as well as primary sleep"),
      },
      outputSchema: listOutput,
      annotations: readOnlyAnnotations,
    },
    async ({ days, include_naps }) => {
      const allRecords = await client.sleeps(days);
      const records = descending(
        include_naps ? allRecords : allRecords.filter((record) => !record.nap),
        (record: SleepRecord) => record.start,
      ).map(formatSleep);
      return result({ window_days: days, count: records.length, records });
    },
  );

  server.registerTool(
    "whoop_cycle_strain_history",
    {
      title: "Get WHOOP cycle strain history",
      description:
        "Recent local physiological-cycle processing state and finalized metrics for SCORED records; a PENDING_SCORE current cycle may expose only provisional_strain.",
      inputSchema: rangeInput,
      outputSchema: listOutput,
      annotations: readOnlyAnnotations,
    },
    async ({ days }) => {
      const records = descending(
        await client.cycles(days),
        (record: CycleRecord) => record.start,
      ).map(formatCycle);
      return result({ window_days: days, count: records.length, records });
    },
  );

  server.registerTool(
    "whoop_workout_history",
    {
      title: "Get WHOOP workout history",
      description:
        "Recent workout sport, local time, duration, and processing state, with score-derived metrics only when WHOOP marks a record SCORED.",
      inputSchema: rangeInput,
      outputSchema: listOutput,
      annotations: readOnlyAnnotations,
    },
    async ({ days }) => {
      const records = descending(
        await client.workouts(days),
        (record: WorkoutRecord) => record.start,
      ).map(formatWorkout);
      return result({ window_days: days, count: records.length, records });
    },
  );

  return server;
}

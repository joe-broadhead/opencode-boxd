// Read before ./isolate.js replaces the environment: the durations, in minutes, for the opt-in measurement of the
// longest call a host allows (machines.test.ts). Import this module before the harness.
export const MEASURE_DEBUG = process.env.BOXD_MEASURE_DEBUG === "1"
export const MEASURE_MINUTES: readonly number[] = (process.env.BOXD_MEASURE_CALL_MINUTES ?? "")
  .split(",")
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value > 0)

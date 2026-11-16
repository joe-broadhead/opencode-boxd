// The spawn-count harness (design §4.4, §7.1): the fake boxd CLI and the fake laptop `opencode` log every child with
// the call tag the runner set, so a test counts one tool call's children by verb, finds a child that bypassed the
// runner, and measures how many children were alive at once.
import { startFakeCli, type FakeCli, type FakeSpawn } from "./fake-cli.js"
import { verbOf, type SpawnCounter, type SpawnCounterOptions, type SpawnRecord, type StartSpawnCounter, type Verb } from "../support/spawn-count.js"

export interface CountingFake extends SpawnCounter {
  /** The fake CLI behind the counter, to seed machines, snapshots, limits and faults. */
  readonly fake: FakeCli
}

const record = (spawn: FakeSpawn): SpawnRecord => ({ call: spawn.call, bin: spawn.bin, argv: spawn.argv, verb: verbOf(spawn.bin, spawn.argv), startedAt: spawn.startedAt, endedAt: spawn.endedAt })

/** The most intervals that overlap at one instant. */
export function peakOf(spawns: readonly SpawnRecord[]): number {
  const edges = spawns.flatMap((spawn) => [
    { at: spawn.startedAt, step: 1 },
    { at: spawn.endedAt, step: -1 },
  ])
  // An end and a start at the same millisecond do not overlap.
  edges.sort((a, b) => a.at - b.at || a.step - b.step)
  let alive = 0
  let peak = 0
  for (const edge of edges) {
    alive += edge.step
    peak = Math.max(peak, alive)
  }
  return peak
}

export const startSpawnCounter: StartSpawnCounter & ((options?: SpawnCounterOptions & { readonly guestPort?: number; readonly version?: string }) => Promise<CountingFake>) = async (options = {}) => {
  const fake = startFakeCli({ ...(options.latencyMs ? { latencyMs: [options.latencyMs[0], options.latencyMs[1]] as [number, number] } : {}), ...("guestPort" in options ? { guestPort: options.guestPort as number } : {}), ...("version" in options ? { version: options.version as string } : {}) })
  let since = 0
  const all = () => fake.spawns().map(record).filter((spawn) => spawn.startedAt >= since)
  return {
    fake,
    boxdBin: fake.bin,
    opencodeBin: fake.opencodeBin,
    spawns: (call) => all().filter((spawn) => call === undefined || spawn.call === call),
    count(call) {
      const counts: Partial<Record<Verb, number>> = {}
      for (const spawn of all()) if (spawn.call === call) counts[spawn.verb] = (counts[spawn.verb] ?? 0) + 1
      return counts
    },
    untagged: () => all().filter((spawn) => spawn.call === null),
    peak: () => peakOf(all()),
    reset() {
      since = Date.now()
    },
    async dispose() {
      fake.dispose()
    },
  }
}

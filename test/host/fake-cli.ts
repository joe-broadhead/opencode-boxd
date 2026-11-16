// The test side of `fake-boxd.mjs`: one folder with the fake laptop `boxd` and `opencode`, the fake guest's own
// `opencode`, the state file, and the machine disks. A test seeds machines, snapshots, limits and faults, and reads
// back the calls, the spawns and what changed. Unit tests, the host harness and the spawn-count harness share it.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type FakeRegion = "fra" | "nyc"

export interface FakeMachine {
  id: string
  name: string
  region: FakeRegion
  status: string
  vcpu: number
  labels: Record<string, string>
  sharing: string
  isolated: boolean
  source: string
  autoSuspend: number
  autoHibernate: number
  ignoreOutbound: string
  deleteAfter?: string
  /** boxd's VM agent does not answer: every exec fails with "cannot connect to VM agent" until a reboot. */
  agentSilent?: boolean
}

export interface FakeSnapshot {
  region: FakeRegion
  name: string
  storage: string
  status: string
  vcpu: number
  labels: Record<string, string>
  disk?: string
}

/** One injected failure: the next call of its verb prints this and exits with `code` (after `hang` ms, if set). */
export interface FakeFault {
  stderr?: string
  stdout?: string
  code?: number
  hang?: number
}

export interface FakeState {
  machines: FakeMachine[]
  snapshots: FakeSnapshot[]
  log: string[]
  version: string
  port: number
  root: string
  nextId: number
  limits?: Partial<Record<FakeRegion | "org", number>>
  limitShape?: "regions" | "org"
  usage?: unknown
  secrets?: unknown[]
  faults?: Record<string, FakeFault[]>
  latencyMs?: [number, number]
  /** The listing carries machine ids (upstream ask U14). */
  listIds?: boolean
  /** `machine new --json` answers with this name instead of the one asked for: a create the plugin must not brand. */
  createAnswersName?: string
  /** `--help` answers as the in-VM CLI. */
  inVm?: boolean
  /** A resize leaves the VM agent silent until a reboot (#14 §6). */
  resizeSilencesAgent?: boolean
  /** Downloads cut off half-way, one per entry. */
  cutCopies?: boolean[]
  wokenByExec?: string[]
  laptopSessions?: Record<string, { title: string; messages: number }>
}

/** One child as the fake binaries logged it. */
export interface FakeSpawn {
  readonly id: string
  /** The fake's own pid: the runner starts it as a process group leader, so it is also its group's id. */
  readonly pid: number
  readonly call: string | null
  readonly bin: "boxd" | "opencode"
  readonly argv: readonly string[]
  readonly startedAt: number
  readonly endedAt: number
}

export interface FakeCli {
  readonly dir: string
  readonly bin: string
  readonly opencodeBin: string
  readonly statePath: string
  read(): FakeState
  update(change: (state: FakeState) => void): void
  /** A machine in a region, as boxd would hold it after a create. */
  machine(input: Partial<FakeMachine> & { name: string; region?: FakeRegion }): FakeMachine
  snapshot(input: Partial<FakeSnapshot> & { name: string; region?: FakeRegion }): void
  fault(verb: string, fault: FakeFault): void
  /** Where the machine's disk is on this laptop: a guest path `p` is at `join(disk(m), p)`. */
  disk(machine: FakeMachine | string): string
  /** Every boxd call but `--help`, as one argv string each. */
  calls(): string[]
  spawns(): FakeSpawn[]
  dispose(): void
}

const SCRIPT = fileURLToPath(new URL("./fake-boxd.mjs", import.meta.url))

/** The fake guest's `opencode`: its version from the machine's disk, `upgrade` writes it, `serve` returns at once. */
const GUEST_OPENCODE = `#!/bin/sh
case "$1" in
  --version) cat "$OPENCODE_BOXD_FAKE_ROOT/.opencode-version" ;;
  upgrade) if [ "$2" != "--major" ]; then echo "$2" > "$OPENCODE_BOXD_FAKE_ROOT/.opencode-version"; fi ;;
  *) exit 0 ;;
esac
`

export function startFakeCli(options: { readonly dir?: string; readonly version?: string; readonly guestPort?: number; readonly latencyMs?: [number, number] } = {}): FakeCli {
  const dir = options.dir ?? realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "boxd-fake-")))
  mkdirSync(join(dir, "guest-bin"), { recursive: true })
  const statePath = join(dir, "state.json")
  const shim = (name: string, extra: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\nBOXD_FAKE_STATE=${JSON.stringify(statePath)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)}${extra} "$@"\n`)
    chmodSync(path, 0o755)
    return path
  }
  const bin = shim("boxd", "")
  const opencodeBin = shim("opencode", " --as-opencode")
  writeFileSync(join(dir, "guest-bin", "opencode"), GUEST_OPENCODE)
  chmodSync(join(dir, "guest-bin", "opencode"), 0o755)
  const root = join(dir, "disks")
  mkdirSync(root, { recursive: true })
  const initial: FakeState = {
    machines: [],
    snapshots: [],
    log: [],
    version: options.version ?? "2.2.6",
    port: options.guestPort ?? 0,
    root,
    nextId: 0,
    ...(options.latencyMs ? { latencyMs: options.latencyMs } : {}),
  }
  writeFileSync(statePath, JSON.stringify(initial))
  writeFileSync(`${statePath}.spawns.jsonl`, "")

  const read = () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState
  /** The same lock the fake binaries take, so a test's change never races a running call. */
  const update = (change: (state: FakeState) => void) => {
    const lock = `${statePath}.lock`
    for (let tries = 0; ; tries++) {
      try {
        mkdirSync(lock)
        break
      } catch {
        if (tries > 4000) throw new Error("the fake boxd state lock was not released")
        Bun.sleepSync(2)
      }
    }
    try {
      const state = read()
      change(state)
      writeFileSync(`${statePath}.test.tmp`, JSON.stringify(state))
      renameSync(`${statePath}.test.tmp`, statePath)
    } finally {
      rmdirSync(lock)
    }
  }
  const disk = (machine: FakeMachine | string) => join(root, typeof machine === "string" ? machine : machine.id)

  return {
    dir,
    bin,
    opencodeBin,
    statePath,
    read,
    update,
    machine(input) {
      let made!: FakeMachine
      update((state) => {
        state.nextId += 1
        made = {
          id: `vm_${String(state.nextId).padStart(4, "0")}`,
          region: "fra",
          status: "running",
          vcpu: 2,
          labels: {},
          sharing: "private",
          isolated: false,
          source: "standalone",
          autoSuspend: 0,
          autoHibernate: 7200,
          ignoreOutbound: "off",
          ...input,
        }
        state.machines.push(made)
        mkdirSync(join(disk(made), "home", "boxd"), { recursive: true })
        if (!existsSync(join(disk(made), ".opencode-version"))) writeFileSync(join(disk(made), ".opencode-version"), `${state.version}\n`)
      })
      return made
    },
    snapshot(input) {
      update((state) => void state.snapshots.push({ region: "fra", storage: "local", status: "ready", vcpu: 2, labels: {}, ...input }))
    },
    fault(verb, fault) {
      update((state) => {
        state.faults ??= {}
        ;(state.faults[verb] ??= []).push(fault)
      })
    },
    disk,
    calls: () => read().log,
    spawns() {
      const lines = readFileSync(`${statePath}.spawns.jsonl`, "utf8").split("\n").filter(Boolean)
      const starts = new Map<string, { id: string; pid: number; call: string | null; bin: "boxd" | "opencode"; argv: string[]; at: number }>()
      const ends = new Map<string, number>()
      for (const line of lines) {
        const entry = JSON.parse(line) as { phase: "start" | "end"; id: string; pid: number; call: string | null; bin: "boxd" | "opencode"; argv: string[]; at: number }
        if (entry.phase === "start") starts.set(entry.id, entry)
        else ends.set(entry.id, entry.at)
      }
      return [...starts.values()].map((start) => ({ id: start.id, pid: start.pid, call: start.call, bin: start.bin, argv: start.argv, startedAt: start.at, endedAt: ends.get(start.id) ?? Number.POSITIVE_INFINITY }))
    },
    dispose() {
      if (!options.dir) rmSync(dir, { recursive: true, force: true })
    },
  }
}

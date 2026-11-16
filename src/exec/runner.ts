/**
 * The one runner for every child process the plugin starts (design §4.1). It owns:
 *
 * - **The pools and their caps.** `foreground` (tool calls) and `background` (the watcher, status guest reads) share
 *   12 slots, the background at most 4 of them; `exec` (`boxd_exec`) has 4 and `import` (the laptop's own `opencode
 *   session delete/import`) has 2, apart from the shared 12. Each pool's queue is first in, first out, and a freed
 *   shared slot goes to the foreground first; a background request passed over 12 times in a row gets the next one,
 *   so the watcher is never starved by a long list call.
 * - **One child per slot, never a slot while waiting.** A slot is taken when a child starts and given back the moment
 *   it exits, so no slot is ever held while a call waits for a machine lock, a poll interval or another pool. That is
 *   the half of the lock order the runner can see; the other half is that a machine lock is taken before, never inside,
 *   another machine's lock, which `withMachineLock` refuses.
 * - **Every bound.** Each child has an explicit timeout (SIGTERM, then SIGKILL after `TIMEOUTS.killGraceMs`, and
 *   `TIMEOUT`), the call's signal (a queued request leaves the queue, a running child is killed, and either answers
 *   `CANCELLED`), and an output cap (`OUTPUT_CAP_BYTES`, then the child is killed). A child runs in its own process
 *   group, so a kill also reaches anything it started.
 * - **The call tag.** Every child gets `CALL_TAG_ENV` set to its call's id, so the spawn-count harness ties each child
 *   to its call; the real CLI ignores it.
 * - **The read rule** (`assertReadable`): a guest read needs a listing at most 2 s old that shows the machine running.
 *   A read whose listing aged in the queue is refused with `rule: "listing-age"`; the CLI port then joins a fresh shared
 *   listing and requeues the read at the front of its pool (`front`), so a queue of reads costs one listing per 2 s
 *   window and never refuses a running machine for its own wait. A machine the listing does not show running is
 *   refused with `kind: "not-readable"`, and nothing is started, so a read never wakes it.
 * - **Health:** children now and at peak, each pool's load, and the event loop's worst delay over the last 5 minutes,
 *   sampled while any child runs or waits (design §4.3).
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { spawn, type ChildProcess } from "node:child_process"
import { basename } from "node:path"
import type { Readable, Writable } from "node:stream"
import { BoxdError, boxdError } from "../errors.js"
import {
  CALL_TAG_ENV,
  CAPS,
  OUTPUT_CAP_BYTES,
  TIMEOUTS,
  type MachineLockKey,
  type OpContext,
  type Pool,
  type ReadTarget,
  type Runner,
  type RunnerHealth,
  type SpawnRequest,
  type SpawnResult,
} from "../ports.js"

/** The process the runner drives: Node's `ChildProcess`, or a test's stand-in with the same few members. */
export interface ChildLike {
  readonly pid?: number | undefined
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: "error", listener: (error: Error) => void): this
  on(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

/** Starts one process. The default spawns it in its own process group, so a kill reaches its whole tree. */
export type Launch = (bin: string, args: readonly string[], options: { readonly env: NodeJS.ProcessEnv }) => ChildLike

export interface RunnerOptions {
  readonly launch?: Launch
  readonly killGraceMs?: number
  readonly now?: () => number
  /** The event-loop sampling interval; 100 ms by default. */
  readonly loopSampleMs?: number
}

/** The runner's own extras beyond the port: what a test and the CLI port use to check the lock rule. */
/**
 * A spawn with a check that runs when the child's slot is granted, just before it starts: the read rule is checked
 * there, so a read that waited in a queue never starts on a listing that has since gone stale (design §4.1).
 */
export type GuardedSpawn = SpawnRequest & {
  readonly guard?: () => void
  /** Wait at the front of the pool's queue: a read retried on a fresh listing, and the listing reads wait for. */
  readonly front?: boolean
}

export interface PluginRunner extends Runner {
  spawn(request: GuardedSpawn): Promise<SpawnResult>
  /**
   * A shared flight that each caller joins with its own signal: one run for every caller with the same key, started
   * outside any caller's machine lock, with a signal of its own that aborts only once every joiner has left. A
   * joiner's Stop detaches that joiner alone (it answers `CANCELLED` at once); the others keep the answer.
   */
  join<T>(key: string, context: OpContext, fn: (context: OpContext) => Promise<T>): Promise<T>
  /** True while the current async context holds this machine's lock. */
  holds(key: MachineLockKey): boolean
  /** How many machine locks are held or waited for now. */
  lockedMachines(): number
}

/** stderr beyond this is cut to its tail: a CLI's error is in its last lines. */
const STDERR_CAP_BYTES = 256 * 1024
/** After this many shared slots went to the foreground while a background request waited, the next is the background's. */
const BACKGROUND_PASS_LIMIT = CAPS.shared
const LAG_WINDOW_MS = 5 * 60_000

const defaultLaunch: Launch = (bin, args, options) =>
  spawn(bin, [...args], { env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }) as ChildProcess

interface Waiter {
  readonly pool: Pool
  /** Queued at the front: after every earlier front waiter, before every other. */
  readonly front: boolean
  readonly start: () => void
  readonly abandon: (error: BoxdError) => void
}

interface Running {
  readonly pool: Pool
  terminate(): void
  /** Resolves when the child has exited and, once it was terminated, its group's SIGKILL has been sent. */
  readonly done: Promise<void>
}

/** After the leader exits, how long its stdout and stderr may stay open (a descendant holding them) before they are cut. */
const DRAIN_MS = 250

const lockKey = (key: MachineLockKey): string => ("id" in key ? `id:${key.id}` : `create:${key.create.region}/${key.create.name}`)

/** The machine locks the current async context holds, innermost last. */
const heldLocks = new AsyncLocalStorage<readonly string[]>()

/** The command a message names: the binary and its subcommand words, up to the first flag. Never its input. */
export function commandOf(bin: string, args: readonly string[]): string {
  const words: string[] = []
  for (const arg of args) {
    if (arg.startsWith("-") || words.length === 4) break
    words.push(arg)
  }
  return [basename(bin), ...words].join(" ")
}

/** A bound as a person writes it: whole seconds, or milliseconds below that. */
export const duration = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`)

/** What a child printed before it was stopped: kept off the error's enumerable details, which reach a tool result. */
export interface PartialOutput {
  readonly stdout: string
  readonly stderr: string
}

const OUTPUT = Symbol("partial output")

/** The output a timed-out or cancelled child printed before it was stopped, for classifying it; never shown as is. */
export function partialOutput(error: unknown): PartialOutput | undefined {
  return error && typeof error === "object" ? (error as { [OUTPUT]?: PartialOutput })[OUTPUT] : undefined
}

function withOutput(error: BoxdError, output: PartialOutput): BoxdError {
  Object.defineProperty(error, OUTPUT, { value: output, enumerable: false })
  return error
}

export function createRunner(options: RunnerOptions = {}): PluginRunner {
  const launch = options.launch ?? defaultLaunch
  const killGraceMs = options.killGraceMs ?? TIMEOUTS.killGraceMs
  const now = options.now ?? Date.now
  const sampleMs = options.loopSampleMs ?? 100

  const queues: Record<Pool, Waiter[]> = { foreground: [], background: [], exec: [], import: [] }
  const active: Record<Pool, number> = { foreground: 0, background: 0, exec: 0, import: 0 }
  const running = new Set<Running>()
  const locks = keyedMutex()
  const flights = new Map<string, Promise<unknown>>()
  const joined = new Map<string, Joined<unknown>>()
  // Lock names carry this runner's own id, so two runners in one process never read each other's locks.
  const instance = `r${++runners}:`
  let peak = 0
  let backgroundPassed = 0
  let disposed = false

  const children = () => active.foreground + active.background + active.exec + active.import
  const shared = () => active.foreground + active.background

  function canStart(pool: Pool): boolean {
    switch (pool) {
      case "foreground":
        return shared() < CAPS.shared
      case "background":
        return shared() < CAPS.shared && active.background < CAPS.background
      case "exec":
        return active.exec < CAPS.exec
      case "import":
        return active.import < CAPS.import
    }
  }

  function grant(pool: Pool): void {
    const waiter = queues[pool].shift()!
    active[pool] += 1
    peak = Math.max(peak, children())
    waiter.start()
  }

  /** Hands every free slot to the next waiter: the foreground first, unless the background has been passed over too often. */
  function pump(): void {
    for (;;) {
      const foreground = queues.foreground.length > 0 && canStart("foreground")
      const background = queues.background.length > 0 && canStart("background")
      if (background && (!foreground || backgroundPassed >= BACKGROUND_PASS_LIMIT)) {
        backgroundPassed = 0
        grant("background")
        continue
      }
      if (foreground) {
        if (queues.background.length > 0 && active.background < CAPS.background) backgroundPassed += 1
        grant("foreground")
        continue
      }
      break
    }
    for (const pool of ["exec", "import"] as const) while (queues[pool].length > 0 && canStart(pool)) grant(pool)
    lag.update()
  }

  function release(pool: Pool): void {
    active[pool] -= 1
    pump()
  }

  // ── The event loop's delay, sampled while any child runs or waits ─────────────────────────────────────────────────
  const lag = (() => {
    const samples: Array<{ readonly at: number; readonly lag: number }> = []
    let timer: ReturnType<typeof setInterval> | undefined
    let expected = 0
    const busy = () => children() > 0 || Object.values(queues).some((queue) => queue.length > 0)
    const prune = () => {
      const floor = now() - LAG_WINDOW_MS
      while (samples.length > 0 && samples[0]!.at < floor) samples.shift()
    }
    return {
      update() {
        if (busy() && !timer && !disposed) {
          expected = Date.now() + sampleMs
          timer = setInterval(() => {
            const at = Date.now()
            samples.push({ at: now(), lag: Math.max(0, at - expected) })
            expected = at + sampleMs
            prune()
          }, sampleMs)
          timer.unref?.()
        } else if ((!busy() || disposed) && timer) {
          clearInterval(timer)
          timer = undefined
        }
      },
      max() {
        prune()
        return samples.reduce((max, sample) => Math.max(max, sample.lag), 0)
      },
    }
  })()

  function cancelled(command: string, inFlight: boolean): BoxdError {
    return boxdError("CANCELLED", inFlight ? `The call was stopped while ${command} ran; it was killed.` : `The call was stopped before ${command} started.`, {
      uncertain: inFlight,
    })
  }

  /** Waits for a slot in the request's pool; a signal or a dispose takes the request out of the queue. */
  function admit(pool: Pool, signal: AbortSignal | undefined, command: string, front = false): Promise<void> {
    if (disposed) return Promise.reject(cancelled(command, false))
    if (signal?.aborted) return Promise.reject(cancelled(command, false))
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const queue = queues[pool]
        const index = queue.indexOf(waiter)
        if (index !== -1) {
          queue.splice(index, 1)
          lag.update()
          reject(cancelled(command, false))
        }
      }
      const waiter: Waiter = {
        pool,
        front,
        start: () => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        },
        abandon: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      // The front is first in, first out too: a read retried on a fresh listing never jumps ahead of one retried
      // earlier, so no retried read is passed over again and again until its retries run out.
      const queue = queues[pool]
      if (front) {
        const after = queue.findIndex((queued) => !queued.front)
        queue.splice(after === -1 ? queue.length : after, 0, waiter)
      } else queue.push(waiter)
      pump()
    })
  }

  function run(request: GuardedSpawn, command: string): Promise<SpawnResult> {
    const pool = request.pool ?? "foreground"
    const started = now()
    const cap = request.stdoutCap ?? OUTPUT_CAP_BYTES
    const env: NodeJS.ProcessEnv = { ...process.env, [CALL_TAG_ENV]: request.call.callId }
    return new Promise<SpawnResult>((resolve, reject) => {
      // A slot granted just before a dispose or a Stop is handed back unused.
      if (disposed || request.signal?.aborted) {
        release(pool)
        reject(cancelled(command, false))
        return
      }
      try {
        request.guard?.()
      } catch (error) {
        release(pool)
        reject(error)
        return
      }
      let child: ChildLike
      try {
        child = launch(request.bin, request.args, { env })
      } catch (error) {
        release(pool)
        reject(missing(request.bin, error))
        return
      }
      const stdout: Buffer[] = []
      let stdoutBytes = 0
      let stderr = Buffer.alloc(0)
      let failure: BoxdError | undefined
      let exited = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let markExited!: () => void
      const exitedOnce = new Promise<void>((resolveExit) => (markExited = resolveExit))
      /** Resolves once the group's SIGKILL is sent: right away when nothing was terminated. */
      let escalated: Promise<void> = Promise.resolve()
      const done = (async () => {
        await exitedOnce
        await escalated
      })()

      const signalGroup = (signal: NodeJS.Signals) => {
        // The child leads its own process group: a negative pid reaches everything it started.
        if (child.pid !== undefined && process.platform !== "win32") {
          try {
            process.kill(-child.pid, signal)
            return
          } catch {
            // The group is gone or was never made; fall back to the child itself.
          }
        }
        try {
          child.kill(signal)
        } catch {
          // Already gone.
        }
      }
      const terminate = () => {
        if (exited || killTimer) return
        signalGroup("SIGTERM")
        // After the grace the whole group gets SIGKILL whatever the leader did: a member that ignores SIGTERM and
        // outlives the leader dies too. A group that is already gone answers ESRCH, which is harmless.
        escalated = new Promise<void>((resolveKill) => {
          killTimer = setTimeout(() => {
            signalGroup("SIGKILL")
            resolveKill()
          }, killGraceMs)
          killTimer.unref?.()
        })
      }
      const stop = (error: BoxdError) => {
        failure ??= error
        terminate()
      }
      const entry: Running = { pool, terminate: () => stop(cancelled(command, true)), done }
      running.add(entry)

      const timer = setTimeout(() => stop(boxdError("TIMEOUT", `${command} did not answer within ${duration(request.timeoutMs)}.`, { step: command })), request.timeoutMs)
      timer.unref?.()
      const onAbort = () => stop(cancelled(command, true))
      if (request.signal?.aborted) onAbort()
      else request.signal?.addEventListener("abort", onAbort, { once: true })

      child.stdout?.on("data", (chunk: Buffer) => {
        if (failure) return
        stdoutBytes += chunk.length
        if (stdoutBytes > cap) {
          stop(boxdError("BOXD_FAILED", `${command} printed more than ${Math.round(cap / 1024 / 1024)} MiB; it was stopped.`, { step: command }))
          return
        }
        stdout.push(chunk)
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk])
        if (stderr.length > STDERR_CAP_BYTES) stderr = stderr.subarray(stderr.length - STDERR_CAP_BYTES)
      })
      // A child that exits before reading its stdin closes the pipe: that is its answer, not a runner failure.
      child.stdin?.on("error", () => {})
      if (request.stdin !== undefined) child.stdin?.end(request.stdin)
      else child.stdin?.end()

      let settled = false
      const finish = (code: number | null, spawnError?: Error) => {
        if (settled) return
        settled = true
        exited = true
        clearTimeout(timer)
        request.signal?.removeEventListener("abort", onAbort)
        markExited()
        // A terminated group keeps its pending SIGKILL; the entry leaves the running set once it is sent.
        void done.then(() => running.delete(entry))
        release(pool)
        const out = Buffer.concat(stdout).toString("utf8")
        const err = stderr.toString("utf8")
        if (spawnError) reject(missing(request.bin, spawnError))
        else if (failure) reject(withOutput(failure, { stdout: out, stderr: err }))
        else resolve({ code: code ?? 1, stdout: out, stderr: err, ms: now() - started })
      }
      child.on("error", (error) => finish(null, error))
      child.on("close", (code) => finish(code))
      // A descendant that holds stdout or stderr open would keep "close" from ever firing: once the child itself has
      // exited, its pipes get a short drain and are then cut, so the request, its slot and a dispose always settle.
      child.on("exit", (code) => {
        const drain = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(code)
        }, DRAIN_MS)
        drain.unref?.()
      })
    })
  }

  return {
    async spawn(request) {
      const command = commandOf(request.bin, request.args)
      await admit(request.pool ?? "foreground", request.signal, command, request.front === true)
      return run(request, command)
    },

    async withMachineLock(key, context, fn) {
      const name = instance + lockKey(key)
      const held = heldLocks.getStore() ?? []
      if (held.includes(name)) return fn()
      if (held.length > 0) {
        // Two machine locks at once could wait on each other: a call holds one machine's lock at a time (design §4.1).
        throw new Error(`Lock order: ${name} was asked for while ${held.join(", ")} is held. Take one machine lock at a time.`)
      }
      if (disposed) throw boxdError("CANCELLED", "The plugin stopped; no machine is changed after that.", { uncertain: false })
      await locks.acquire(name, context)
      try {
        return await heldLocks.run([...held, name], fn)
      } finally {
        locks.release(name)
      }
    },

    singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const current = flights.get(key) as Promise<T> | undefined
      if (current) return current
      // A flight runs for every caller, so it holds no caller's machine lock: it takes its own, like any call.
      const flight = heldLocks.exit(() => (async () => fn())()).finally(() => flights.delete(key))
      flights.set(key, flight)
      return flight
    },

    join<T>(key: string, context: OpContext, fn: (context: OpContext) => Promise<T>): Promise<T> {
      const command = `the shared ${key.split(":")[1] ?? key}`
      if (disposed || context.signal?.aborted) return Promise.reject(cancelled(command, false))
      let flight = joined.get(key) as Joined<T> | undefined
      if (!flight) {
        const controller = new AbortController()
        const created: Joined<T> = { joiners: 0, controller, promise: Promise.resolve(undefined as T) }
        const flightContext: OpContext = { call: context.call, ...(context.pool ? { pool: context.pool } : {}), signal: controller.signal }
        created.promise = heldLocks.exit(() => (async () => fn(flightContext))()).finally(() => {
          if (joined.get(key) === created) joined.delete(key)
        })
        created.promise.catch(() => {})
        joined.set(key, created)
        flight = created
      }
      const current = flight
      current.joiners += 1
      return new Promise<T>((resolve, reject) => {
        let left = false
        const leave = () => {
          if (left) return false
          left = true
          context.signal?.removeEventListener("abort", onAbort)
          current.joiners -= 1
          return true
        }
        const onAbort = () => {
          if (!leave()) return
          // The last joiner to leave stops the flight; a later caller starts a new one.
          if (current.joiners === 0) {
            if (joined.get(key) === current) joined.delete(key)
            current.controller.abort()
          }
          reject(cancelled(command, false))
        }
        context.signal?.addEventListener("abort", onAbort, { once: true })
        current.promise.then(
          (value) => leave() && resolve(value),
          (error: unknown) => leave() && reject(error),
        )
      })
    },

    assertReadable(target) {
      assertReadable(target, now())
    },

    lockedMachines: () => locks.held(),

    holds(key) {
      return (heldLocks.getStore() ?? []).includes(instance + lockKey(key))
    },

    health(): RunnerHealth {
      const pool = (name: Pool, cap: number) => ({ running: active[name], queued: queues[name].length, cap })
      return {
        children: { now: children(), peak, cap: CAPS.shared + CAPS.exec + CAPS.import },
        pools: {
          foreground: pool("foreground", CAPS.shared),
          background: pool("background", CAPS.background),
          exec: pool("exec", CAPS.exec),
          import: pool("import", CAPS.import),
        },
        loopLagMaxMs: lag.max(),
      }
    },

    /**
     * On plugin disposal or reload: queued children and lock waiters answer `CANCELLED` at once, every running child
     * gets SIGTERM and then SIGKILL after the grace, and it resolves once none is left: within the grace and a little.
     */
    async dispose() {
      disposed = true
      for (const queue of Object.values(queues)) {
        for (const waiter of queue.splice(0)) waiter.abandon(cancelled("a queued command", false))
      }
      locks.dispose()
      flights.clear()
      for (const flight of joined.values()) flight.controller.abort()
      joined.clear()
      for (const entry of [...running]) entry.terminate()
      // Bounded: each child gets SIGTERM, its group SIGKILL after the grace, and a child whose pipes a descendant holds
      // is settled by its exit and the drain; the extra second is a margin, never a wait on a stuck pipe.
      const bound = new Promise<void>((resolveBound) => setTimeout(resolveBound, killGraceMs + DRAIN_MS + 1_000).unref?.())
      await Promise.race([Promise.all([...running].map((entry) => entry.done)), bound])
      lag.update()
    },
  }
}

let runners = 0

interface Joined<T> {
  joiners: number
  readonly controller: AbortController
  promise: Promise<T>
}

/**
 * One lock per key, handed over first in, first out. A waiter's signal takes it out of the queue with `CANCELLED`, so a
 * stopped call never holds or waits for a machine.
 */
function keyedMutex() {
  const entries = new Map<string, Array<{ readonly grant: () => void; readonly abandon: (error: BoxdError) => void }>>()
  return {
    acquire(name: string, context: OpContext): Promise<void> {
      const signal = context.signal
      if (signal?.aborted) return Promise.reject(boxdError("CANCELLED", "The call was stopped while it waited for a machine.", { uncertain: false }))
      const waiters = entries.get(name)
      if (!waiters) {
        entries.set(name, [])
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = waiters.indexOf(waiter)
          if (index !== -1) waiters.splice(index, 1)
          reject(boxdError("CANCELLED", "The call was stopped while it waited for a machine.", { uncertain: false }))
        }
        const waiter = {
          grant: () => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
          },
          abandon: (error: BoxdError) => {
            signal?.removeEventListener("abort", onAbort)
            reject(error)
          },
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        waiters.push(waiter)
      })
    },
    release(name: string): void {
      const waiters = entries.get(name)
      if (!waiters) return
      const next = waiters.shift()
      if (next) next.grant()
      else entries.delete(name)
    },
    /** Every waiter answers CANCELLED and no lock is left held: a holder still unwinding releases nothing that waits. */
    dispose(): void {
      for (const waiters of entries.values()) for (const waiter of waiters.splice(0)) waiter.abandon(boxdError("CANCELLED", "The plugin stopped while the call waited for a machine.", { uncertain: false }))
      entries.clear()
    },
    held: () => entries.size,
  }
}

/** The read rule (design §4.1, M1): a listing at most 2 s old that shows this machine running, by name and region. */
export function assertReadable(target: ReadTarget, at: number): void {
  const age = at - target.listing.takenAt
  if (age > TIMEOUTS.readListingMaxAgeMs) {
    throw boxdError("BOXD_FAILED", `A guest read of ${target.name} needs a machine listing at most ${duration(TIMEOUTS.readListingMaxAgeMs)} old; this one is ${duration(Math.max(0, Math.round(age)))} old.`, {
      rule: "listing-age",
      kind: "listing-stale",
    })
  }
  const row = target.listing.machines.find((machine) => machine.name === target.name && machine.region === target.region)
  if (!row || row.status !== "running") {
    throw boxdError("MACHINE_ASLEEP", row ? `${target.name} is ${row.status}, and a read never wakes a machine.` : `${target.name} is not in the ${target.region} listing, and a read never wakes a machine.`, {
      kind: "not-readable",
      status: row?.status ?? "absent",
    })
  }
  // Once boxd's listing carries ids (U14), a read compares them: a name that now points at another machine is not ours.
  if (row.id !== null && target.machineId !== null && row.id !== target.machineId) {
    throw boxdError("NOT_OURS", `${target.name} in ${target.region} is now machine ${row.id}, not the recorded ${target.machineId}. Nothing was read.`)
  }
}

function missing(bin: string, error: unknown): BoxdError {
  const reason = error instanceof Error ? error.message : String(error)
  return boxdError("BOXD_MISSING", `${basename(bin)} could not be run (${reason.split("\n")[0]}).`)
}

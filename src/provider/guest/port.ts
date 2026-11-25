/**
 * The laptop side of the guest port (design §3, §4.1): each helper action is one `machine exec` of
 * `python3 ~/.opencode-boxd/guest.py`, with its request on stdin and one JSON line back.
 *
 * - **Reads** (`serve`, `phase`, `read`, `health`) pass the read rule in the CLI port, use only the helper already on
 *   the machine, never upload anything, and take no machine lock. Two identical reads in flight share one answer, and a
 *   machine has at most one read exec at a time.
 * - **Changes** run on a target from `checkOwned`, inside the machine's lock (the CLI port checks both). Each sends the
 *   sha256 of the helper this plugin ships: a machine with no helper, or another copy, changes nothing; the plugin
 *   uploads its own with `machine cp` and runs it once with `--install`, which moves it to the stable path first. A
 *   steady-state change is therefore one exec.
 * - **Bounds:** reads 10 s, changes 30 s, `upgrade` 180 s, each passed to boxd as `machine exec --timeout` (2 s less),
 *   so boxd kills the remote side too, and the laptop kills the CLI at the full bound.
 */
import { BoxdError, boxdError } from "../../errors.js"
import {
  GUEST_HELPER_PATH,
  TIMEOUTS,
  type BoxdPort,
  type ChangeTarget,
  type GuestPort,
  type OpContext,
  type ReadTarget,
  type SpawnResult,
} from "../../ports.js"
import { shortReason } from "../../redact.js"
import { isChangeTarget } from "../boxd/cli.js"
import type { PluginRunner } from "../runner.js"
import {
  checkProtocol,
  helperError,
  helperLine,
  readExport,
  readGit,
  readHealth,
  readImport,
  readPhase,
  readPrompt,
  readRead,
  readScrub,
  readServe,
  readSetup,
  readUpgrade,
} from "./answers.js"
import { HELPER_UPLOAD_PATH, helperFile, packagedHelperPath } from "./helper.js"

export interface GuestPortOptions {
  readonly boxd: BoxdPort
  readonly runner: PluginRunner
  /** The helper to upload; the package's `guest/guest.py` by default. */
  readonly helperPath?: string
}

type Json = Record<string, unknown>

/** What Python says for a script that is not there: the machine has no helper yet. */
const NO_SCRIPT = /can't open file .*\[Errno 2\]/

const seconds = (ms: number) => Math.max(1, Math.floor((ms - TIMEOUTS.killGraceMs) / 1000))

export function createGuestPort(options: GuestPortOptions): GuestPort {
  const { boxd, runner } = options
  const helperPath = options.helperPath ?? packagedHelperPath()
  /** One read exec per machine at a time: the next read waits for the one in flight. */
  const readTails = new Map<string, Promise<unknown>>()

  function serialised<T>(machine: string, fn: () => Promise<T>): Promise<T> {
    const previous = readTails.get(machine) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.catch(() => undefined)
    readTails.set(machine, tail)
    void tail.then(() => {
      if (readTails.get(machine) === tail) readTails.delete(machine)
    })
    return next
  }

  async function exec(target: ReadTarget | ChangeTarget, script: string, request: Json, timeoutMs: number, action: string, context: OpContext): Promise<SpawnResult> {
    try {
      return await boxd.exec(target, `python3 ${script}`, { timeoutSeconds: seconds(timeoutMs), json: false, stdin: JSON.stringify(request) }, context)
    } catch (error) {
      if (error instanceof BoxdError && error.code === "TIMEOUT") {
        throw boxdError("TIMEOUT", `The guest helper's ${action} on ${target.name} did not answer within ${Math.round(timeoutMs / 1000)} s.`, { step: action })
      }
      throw error
    }
  }

  /** The helper's answer, or the reason there is none. */
  function answerOf(result: SpawnResult, action: string): Json {
    const answer = helperLine(result.stdout)
    if (!answer) {
      const said = shortReason(result.stderr.split("\n").find((line) => line.trim() !== "") ?? "")
      throw boxdError("GUEST_FAILED", NO_SCRIPT.test(result.stderr) ? `The machine has no guest helper at ${GUEST_HELPER_PATH}, and a read never uploads one.` : `The guest helper's ${action} printed no answer${said ? ` (${said})` : ""}.`)
    }
    checkProtocol(action, answer)
    if (answer.ok !== true) throw helperError(action, answer)
    return answer
  }

  function read<T>(action: string, target: ReadTarget, input: Json, context: OpContext, parse: (answer: Json) => T): Promise<T> {
    if (isChangeTarget(target as ReadTarget | ChangeTarget)) throw new Error(`The guest read ${action} takes a read target with its listing.`)
    const machine = `${target.region}/${target.name}`
    const request = { action, ...input }
    return runner.join(`guest:${machine}:${JSON.stringify(request)}`, context, (flight) =>
      serialised(machine, async () => parse(answerOf(await exec(target, GUEST_HELPER_PATH, request, TIMEOUTS.helperRead, action, flight), action))),
    )
  }

  async function change<T>(action: string, target: ChangeTarget, input: Json, context: OpContext, timeoutMs: number, parse: (answer: Json, uploaded: boolean) => T): Promise<T> {
    if (!isChangeTarget(target)) throw new Error(`The guest change ${action} needs a target from checkOwned.`)
    const helper = await helperFile(helperPath)
    const request = { action, helper: helper.sha256, ...input }
    const first = await exec(target, GUEST_HELPER_PATH, request, timeoutMs, action, context)
    const answer = helperLine(first.stdout)
    const stale = answer?.ok === false && answer.error === "HELPER_OUTDATED"
    if (answer && !stale) return parse(answerOf(first, action), false)
    if (!answer && !NO_SCRIPT.test(first.stderr)) answerOf(first, action)
    // No helper, or another copy: upload this plugin's, which installs itself at the stable path and then acts.
    await boxd.copyTo(target, helper.path, HELPER_UPLOAD_PATH, context)
    const second = await exec(target, `${HELPER_UPLOAD_PATH} --install`, request, timeoutMs, action, context)
    return parse(answerOf(second, action), true)
  }

  return {
    serve: (target, input, context) => read("serve", target, input.directory !== undefined ? { directory: input.directory } : {}, context, readServe),
    phase: (target, input, context) =>
      read(
        "phase",
        target,
        { sessionId: input.sessionId, ...(input.tail ? { tail: input.tail } : {}), ...(input.full ? { full: true } : {}) },
        context,
        (answer) => readPhase(answer, input.full === true),
      ),
    read: (target, input, context) =>
      read(
        "read",
        target,
        { directory: input.directory, maxBytes: input.maxBytes, ...(input.path !== undefined ? { path: input.path } : {}), ...(input.log ? { log: input.log } : {}), ...(input.tail ? { tail: input.tail } : {}) },
        context,
        (answer) => readRead(answer, input.log === "server" ? "server.log" : (input.path ?? "")),
      ),
    health: (target, context) => read("health", target, {}, context, readHealth),

    setup: (target, input, context) =>
      change("setup", target, { directory: input.directory, ...(input.repo ? { repo: input.repo } : {}), ...(input.git ? { git: input.git } : {}), opencode: input.opencode }, context, TIMEOUTS.setup, readSetup),
    prompt: (target, input, context) =>
      change(
        "prompt",
        target,
        {
          directory: input.directory,
          sessionId: input.sessionId,
          title: input.title,
          text: input.text,
          delivery: input.delivery,
          ...(input.model ? { model: input.model } : {}),
          ...(input.files?.length ? { files: input.files } : {}),
        },
        context,
        TIMEOUTS.helperChange,
        readPrompt,
      ),
    interrupt: (target, input, context) => change("interrupt", target, { sessionId: input.sessionId }, context, TIMEOUTS.helperChange, () => undefined),
    upgrade: (target, input, context) => change("upgrade", target, { version: input.version }, context, TIMEOUTS.upgrade, readUpgrade),
    export: (target, input, context) => change("export", target, { rootId: input.rootId, ...(input.partial ? { partial: true } : {}) }, context, TIMEOUTS.helperChange, readExport),
    import: (target, input, context) => change("import", target, { directory: input.directory, files: input.files }, context, TIMEOUTS.helperChange, readImport),
    git: (target, input, context) => change("git", target, { directory: input.directory, ...(input.rootId ? { rootId: input.rootId } : {}) }, context, TIMEOUTS.helperChange, readGit),
    scrub: (target, context) => change("scrub", target, {}, context, TIMEOUTS.helperChange, readScrub),
  }
}

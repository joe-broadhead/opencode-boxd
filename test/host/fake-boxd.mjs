#!/usr/bin/env node
// A fake laptop boxd CLI (0.3.8; the external surface is recorded in `test/fixtures/boxd-cli-help.json`) for the unit
// and host tests, and the fake laptop `opencode` beside it
// (`--as-opencode`). It never touches a real machine: every command answers from a JSON state file (BOXD_FAKE_STATE),
// with the real CLI's argv, JSON keys and error words, so a wrong flag fails here as it would there.
//
// - Machines live in regions (`fra`, `nyc`), have ids, labels, a size and a status; names are unique per region.
// - `machine exec` runs the real guest helper (`python3 <path>`) against a folder that stands in for the machine's disk
//   (BOXD_FAKE_ROOT) and the test's loopback guest server (the request's `base`); any other command runs in a
//   shell in that folder. An exec wakes a hibernated machine, as boxd does: that is what the read rule guards against.
// - `faults` in the state injects one failure per verb (its stderr and exit code), `agentSilent` on a machine answers
//   "cannot connect to VM agent", and `latencyMs` delays every call.
// - Every spawn is logged to `<state>.spawns.jsonl` with its call tag (BOXD_PLUGIN_CALL), its argv and its start and
//   end, which is how the spawn-count harness counts and times a call's children. `log` in the state holds every boxd
//   call but `--help`, as one string each.
import { spawnSync } from "node:child_process"
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"
import { acquire, release } from "./fake-lock.mjs"

const statePath = process.env.BOXD_FAKE_STATE
if (!statePath) {
  process.stderr.write("the fake boxd CLI needs BOXD_FAKE_STATE\n")
  process.exit(2)
}
const REGIONS = ["fra", "nyc"]
const HOME = "/home/boxd"

const asOpencode = process.argv[2] === "--as-opencode"
const argv = process.argv.slice(asOpencode ? 3 : 2)
const spawnId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const spawnLog = `${statePath}.spawns.jsonl`
const logLine = (value) => appendFileSync(spawnLog, `${JSON.stringify(value)}\n`)
logLine({ phase: "start", id: spawnId, pid: process.pid, call: process.env.BOXD_PLUGIN_CALL ?? null, bin: asOpencode ? "opencode" : "boxd", argv, at: Date.now() })
const ended = () => logLine({ phase: "end", id: spawnId, at: Date.now() })
process.on("exit", ended)
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(143))

const read = () => JSON.parse(readFileSync(statePath, "utf8"))

const lock = `${statePath}.lock`
let holdingLock = false
// A command that fails while it holds the lock exits through process.exit, which skips `finally`: release it here.
process.on("exit", () => {
  if (holdingLock) release(lock)
})

/** Every change to the state happens under the lock (`fake-lock.mjs`), on a fresh read, and lands by rename. */
function update(change) {
  acquire(lock)
  holdingLock = true
  try {
    const current = read()
    const result = change(current)
    const temp = `${statePath}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(current, null, 1))
    renameSync(temp, statePath)
    return result
  } finally {
    holdingLock = false
    release(lock)
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

{
  const latency = read().latencyMs
  if (Array.isArray(latency)) sleep(latency[0] + Math.random() * Math.max(0, latency[1] - latency[0]))
}

if (asOpencode) {
  laptopOpencode()
  process.exit(0)
}

// `boxd --help` reads nothing: it answers the laptop CLI's help, or the in-VM one's when the state says so.
if (argv.length === 1 && argv[0] === "--help") {
  const state = read()
  process.stdout.write(
    state.inVm
      ? "boxd VM management CLI\n\nCommands:\n  local      Interact with your local machine (laptop) from inside the VM\n\nOptions:\n      --region <REGION>\n          Default: BOXD_REGION. boxd inside a machine acts in its machine's region only.\n"
      : "boxd — create and control your machines from the terminal\n\nCommands:\n  machine    Create, inspect, and control your machines [aliases: m]\n",
  )
  process.exit(0)
}

update((state) => { state.log.push(argv.join(" ")) })

// ── Argv, as clap reads it ────────────────────────────────────────────────────────────────────────────────────────

/** Flags each verb takes: 1 takes a value, 0 is a switch, "many" repeats. `--region` and `--json` are global. */
const SPEC = {
  "machine list": { flags: { "--label": "many" }, positionals: 0 },
  "machine get": { flags: {}, positionals: 1 },
  "machine new": {
    flags: {
      "--from-snapshot": 1,
      "--label": "many",
      "--auto-suspend-timeout": 1,
      "--auto-hibernate-timeout": 1,
      "--idle-ignore-outbound": "optional",
      "--delete-after": 1,
      "--vcpu": 1,
      "--memory": 1,
      "--shared": 0,
      "--isolated": 0,
    },
    positionals: 1,
  },
  "machine wake": { flags: {}, positionals: 1 },
  "machine hibernate": { flags: {}, positionals: 1 },
  "machine reboot": { flags: {}, positionals: 1 },
  "machine remove": { flags: { "-y": 0, "--confirm": 0 }, positionals: 1 },
  "machine resize": { flags: { "--vcpu": 1, "--memory": 1, "-y": 0, "--confirm": 0 }, positionals: 1 },
  "machine rename": { flags: { "-y": 0, "--confirm": 0 }, positionals: 2 },
  "machine label": { flags: {}, positionals: 4 },
  "machine config": { flags: {}, positionals: 4 },
  "machine exec": { flags: { "--timeout": 1, "--tty": 0, "-e": "many" }, positionals: "rest" },
  "machine cp": { flags: { "-r": 0, "--mode": 1 }, positionals: 2 },
  "manage machine-limit": { flags: {}, positionals: 1 },
  "manage usage": { flags: { "--since": 1, "--until": 1 }, positionals: 0 },
  "snapshots list": { flags: {}, positionals: 0 },
  "snapshots save": { flags: {}, positionals: 2 },
  "snapshots rm": { flags: { "-y": 0, "--confirm": 0 }, positionals: 1 },
  "snapshots remove": { flags: { "-y": 0, "--confirm": 0 }, positionals: 1 },
  "env list": { flags: {}, positionals: 0 },
}

function parse(args) {
  const verb = `${args[0] ?? ""} ${args[1] ?? ""}`
  const spec = SPEC[verb]
  if (!spec) fail(`error: unrecognized subcommand '${args.slice(0, 2).join(" ")}'`, 2)
  const flags = {}
  const positionals = []
  let rest
  for (let index = 2; index < args.length; index++) {
    const token = args[index]
    if (token === "--") {
      rest = args.slice(index + 1)
      break
    }
    if (token.startsWith("-") && token !== "-") {
      const [name, inline] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined]
      const kind = name === "--region" ? 1 : name === "--json" ? 0 : spec.flags[name]
      if (kind === undefined) fail(`error: unexpected argument '${name}' found\n\n  tip: to pass '${name}' as a value, use '-- ${name}'`, 2)
      if (kind === 0) flags[name] = true
      else if (kind === "optional") flags[name] = inline ?? "on"
      else {
        index += 1
        const value = inline ?? args[index]
        if (value === undefined) fail(`error: a value is required for '${name}' but none was supplied`, 2)
        if (kind === "many") {
          flags[name] ??= []
          flags[name].push(value)
        } else flags[name] = value
      }
      continue
    }
    positionals.push(token)
  }
  if (spec.positionals !== "rest" && positionals.length > spec.positionals) fail(`error: unexpected argument '${positionals[spec.positionals]}' found`, 2)
  const region = flags["--region"] ?? "fra"
  if (region !== "all" && !REGIONS.includes(region)) fail(`error: unknown region "${region}"`)
  return { verb, flags, positionals, rest, region }
}

const SIZES = { 1: 4, 2: 8, 4: 16, 8: 32 }
const sizeLine = (vcpu) => `${vcpu} vCPU · ${SIZES[vcpu]} GiB`
const machineRoot = (state, machine) => join(state.root, machine.id)
const toLocal = (state, machine, path) => {
  const clean = normalize(path)
  if (!clean.startsWith("/") || clean.includes("..")) fail(`error: bad path ${path}`)
  return join(machineRoot(state, machine), clean)
}

function find(state, region, nameOrId) {
  return state.machines.find((machine) => machine.region === region && machine.status !== "destroyed" && (machine.name === nameOrId || machine.id === nameOrId))
}

/** boxd 0.3's not-found answer, with its hint when the name exists in another region. */
function notFound(state, region, nameOrId) {
  const other = state.machines.find((machine) => machine.region !== region && machine.status !== "destroyed" && machine.name === nameOrId)
  fail(`error: no machine "${nameOrId}" in ${region}${other ? `\nThere is a machine named "${nameOrId}" in ${other.region}; pass --region ${other.region}.` : ""}`)
}

function must(state, region, nameOrId) {
  if (region === "all") fail("error: --region all works for lists only")
  return find(state, region, nameOrId) ?? notFound(state, region, nameOrId)
}

/** One injected failure for this verb, used once. */
function fault(verb) {
  const injected = update((state) => {
    const queued = state.faults?.[verb]
    if (!queued?.length) return undefined
    return queued.shift()
  })
  if (injected) {
    if (injected.stdout) process.stdout.write(injected.stdout)
    if (injected.hang) sleep(injected.hang)
    fail(injected.stderr ?? "error: injected failure", injected.code ?? 1)
  }
}

function machineJson(machine, full) {
  return {
    name: machine.name,
    ...(full || machine.listIds ? { id: machine.id } : {}),
    region: machine.region,
    status: machine.status,
    size: sizeLine(machine.vcpu),
    vcpu: machine.vcpu,
    memory_bytes: SIZES[machine.vcpu] * 1024 ** 3,
    source: machine.source,
    sharing: machine.sharing,
    labels: machine.labels,
    ...(full
      ? {
          isolated: machine.isolated ? "yes" : "no",
          auto_suspend: machine.autoSuspend === 0 ? "off" : `${machine.autoSuspend}s`,
          auto_hibernate: machine.autoHibernate === 0 ? "off" : `${machine.autoHibernate}s`,
          idle_ignore_outbound: machine.ignoreOutbound,
          delete_after: machine.deleteAfter ?? "-",
        }
      : {}),
  }
}

// ── The commands ──────────────────────────────────────────────────────────────────────────────────────────────────

const { verb, flags, positionals, rest, region } = parse(argv)
fault(verb)

switch (verb) {
  case "machine list": {
    const state = read()
    out(state.machines.filter((machine) => machine.status !== "destroyed" && (region === "all" || machine.region === region)).map((machine) => machineJson({ ...machine, listIds: state.listIds }, false)))
    break
  }
  case "machine get": {
    const state = read()
    out(machineJson(must(state, region, positionals[0]), true))
    break
  }
  case "machine new": {
    const name = positionals[0]
    if (flags["--shared"] || flags["--isolated"]) fail("the plugin must never ask for --shared or --isolated")
    if ((flags["--vcpu"] || flags["--memory"]) && flags["--from-snapshot"]) fail("error: --vcpu/--memory only apply to fresh machines; forks and snapshot restores keep their source's size")
    const created = update((state) => {
      if (find(state, region, name)) fail(`error: a machine named "${name}" already exists in ${region}`)
      const used = state.machines.filter((machine) => machine.region === region && machine.status !== "destroyed").length
      const limit = state.limits?.[region] ?? 300
      if (used >= limit) fail(`error: your org has reached its machine limit (${limit} machines in ${region}). Ask for more with \`boxd manage machine-limit request --max-vms <n>\`.`)
      const snapshot = flags["--from-snapshot"] ? state.snapshots.find((item) => item.region === region && item.name === flags["--from-snapshot"]) : undefined
      if (flags["--from-snapshot"] && !snapshot) fail(`error: no snapshot "${flags["--from-snapshot"]}" in ${region}`)
      const labels = { ...(snapshot?.labels ?? {}) }
      for (const pair of flags["--label"] ?? []) labels[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1)
      state.nextId = (state.nextId ?? 0) + 1
      const machine = {
        id: `vm_${state.nextId.toString().padStart(4, "0")}`,
        name,
        region,
        status: "running",
        vcpu: snapshot?.vcpu ?? Number(flags["--vcpu"] ?? 2),
        labels,
        sharing: "private",
        isolated: false,
        source: snapshot ? `snapshot/${snapshot.name}` : "standalone",
        autoSuspend: Number(flags["--auto-suspend-timeout"] ?? 0),
        autoHibernate: Number(flags["--auto-hibernate-timeout"] ?? 14400),
        ignoreOutbound: flags["--idle-ignore-outbound"] ?? "off",
        deleteAfter: flags["--delete-after"],
      }
      state.machines.push(machine)
      const root = machineRoot(state, machine)
      mkdirSync(join(root, HOME), { recursive: true })
      if (snapshot?.disk && existsSync(snapshot.disk)) cpSync(snapshot.disk, root, { recursive: true })
      if (!existsSync(join(root, ".opencode-version"))) writeFileSync(join(root, ".opencode-version"), `${state.version}\n`)
      return machine
    })
    const answered = read().createAnswersName ?? created.name
    out({ boot: "11ms", id: created.id, name: answered, paused_automations: 0, source: created.source, url: `${answered}.boxd.sh` })
    break
  }
  case "machine wake":
  case "machine hibernate":
  case "machine reboot":
  case "machine remove":
  case "machine resize":
  case "machine rename": {
    const answer = update((state) => {
      const machine = must(state, region, positionals[0])
      if (verb === "machine wake") {
        machine.status = "running"
        // A cold wake restores the VM before its guest's OpenCode is listening again.
        machine.downPolls = state.wakeDownPolls ?? 0
      }
      if (verb === "machine hibernate") machine.status = "hibernated"
      if (verb === "machine reboot" || verb === "machine resize" || verb === "machine rename") {
        // A reboot clears /tmp and the running processes; the disk stays.
        rmSync(join(machineRoot(state, machine), "tmp"), { recursive: true, force: true })
        machine.status = "running"
        machine.agentSilent = false
      }
      if (verb === "machine remove") {
        if (!flags["-y"] && !flags["--confirm"]) fail("error: removing a machine needs -y in scripts")
        machine.status = "destroyed"
      }
      if (verb === "machine resize") {
        if (!flags["-y"] && !flags["--confirm"]) fail("error: a resize of a running machine needs -y")
        machine.vcpu = Number(flags["--vcpu"])
        if (state.resizeSilencesAgent) machine.agentSilent = true
      }
      if (verb === "machine rename") {
        if (!flags["-y"] && !flags["--confirm"]) fail("error: a rename reboots the machine and needs -y")
        if (find(state, region, positionals[1])) fail(`error: a machine named "${positionals[1]}" already exists in ${region}`)
        machine.name = positionals[1]
      }
      return { name: machine.name, status: verb === "machine remove" ? "destroyed" : machine.status }
    })
    out(answer)
    break
  }
  case "machine label": {
    const [action, nameOrId, key, value] = positionals
    if (action !== "set") fail(`error: unsupported label command ${action}`)
    update((state) => {
      must(state, region, nameOrId).labels[key] = value ?? ""
    })
    process.stdout.write(`label ${key}=${value ?? ""} set\n`)
    break
  }
  case "machine config": {
    const [action, nameOrId, key, value] = positionals
    if (action !== "set") fail(`error: unsupported config command ${action}`)
    if (!["delete-after", "auto-hibernate.timeout", "auto-suspend.timeout", "idle.ignore-outbound"].includes(key)) fail(`error: unknown setting ${key}`)
    update((state) => {
      const machine = must(state, region, nameOrId)
      if (key === "delete-after") machine.deleteAfter = value
    })
    process.stdout.write(`${key} for ${nameOrId}: ${value}\n`)
    break
  }
  case "machine exec":
    exec()
    break
  case "machine cp":
    copy()
    break
  case "manage machine-limit": {
    const state = read()
    const inUse = (name) => state.machines.filter((machine) => machine.region === name && machine.status !== "destroyed").length
    if (state.limitShape === "org") {
      out({ max_vms: state.limits?.org ?? 300, machines: state.machines.filter((machine) => machine.status !== "destroyed").length })
    } else {
      out({ regions: REGIONS.map((name) => ({ region: name, limit: state.limits?.[name] ?? 300, in_use: inUse(name) })) })
    }
    break
  }
  case "manage usage": {
    const state = read()
    if (!state.usage) fail("error: machine usage is for org owners and admins only")
    out(state.usage)
    break
  }
  case "snapshots list": {
    const state = read()
    out(state.snapshots.filter((item) => region === "all" || item.region === region).map(({ region: where, name, storage, status }) => ({ name, region: where, storage, status, version: 1 })))
    break
  }
  case "snapshots save": {
    const [nameOrId, name] = positionals
    const saved = update((state) => {
      const machine = must(state, region, nameOrId)
      state.snapshots = state.snapshots.filter((item) => !(item.region === region && item.name === name))
      const disk = join(state.root, `snapshot-${region}-${name}`)
      rmSync(disk, { recursive: true, force: true })
      cpSync(machineRoot(state, machine), disk, { recursive: true })
      state.snapshots.push({ region, name, storage: "local", status: "ready", vcpu: machine.vcpu, labels: { ...machine.labels }, disk })
      return { name, status: "ready", version: 1 }
    })
    out(saved)
    break
  }
  case "snapshots rm":
  case "snapshots remove": {
    const name = positionals[0]
    update((state) => {
      if (!state.snapshots.some((item) => item.region === region && item.name === name)) fail(`error: no snapshot "${name}" in ${region}`)
      state.snapshots = state.snapshots.filter((item) => !(item.region === region && item.name === name))
    })
    out({ deleted: name })
    break
  }
  case "env list": {
    const state = read()
    out({ env: [{ name: "PLAIN_SETTING", scope: "all", value: "plain-value-visible" }], secret: state.secrets ?? [] })
    break
  }
}

// ── machine exec and machine cp ───────────────────────────────────────────────────────────────────────────────────

function exec() {
  const [nameOrId] = positionals
  const command = (rest ?? positionals.slice(1)).join(" ")
  const { state, machine } = update((current) => {
    const found = must(current, region, nameOrId)
    if (found.status === "destroyed" || found.status === "stopped") fail(`error: ${found.name} is ${found.status}`)
    // boxd wakes a hibernated machine for an exec: the read rule exists so the plugin never relies on this.
    if (found.status !== "running") {
      current.wokenByExec = [...(current.wokenByExec ?? []), found.name]
      found.status = "running"
    }
    return { state: current, machine: { ...found } }
  })
  if (machine.agentSilent) fail("error: cannot connect to VM agent: connection refused")
  const root = machineRoot(state, machine)
  const timeoutMs = flags["--timeout"] ? Number(flags["--timeout"]) * 1000 : undefined
  const env = { ...process.env, BOXD_FAKE_ROOT: root, PATH: `${join(dirname(statePath), "guest-bin")}:${process.env.PATH}`, HOME: join(root, HOME), GIT_CONFIG_NOSYSTEM: "1" }
  delete env.BOXD_PLUGIN_CALL
  // A guest has the secrets its own machine was given, never the ones of the machine that runs the tests.
  for (const name of Object.keys(env)) if (/TOKEN|API_KEY|SECRET|ACCESS_KEY|^AWS_|^GH_|^GITHUB_/.test(name)) delete env[name]
  Object.assign(env, state.guestEnv ?? {})
  const helper = /^python3 (\/[\w./-]+)( --install)?$/.exec(command)
  let result
  if (helper) {
    // The helper talks to its own localhost OpenCode; here that is the test's loopback fake.
    const input = readFileSync(0, "utf8")
    let request = input
    try {
      const parsed = JSON.parse(input)
      // The helper action this exec asked for, logged beside its spawn, so a test can tell a prompt from a read.
      if (parsed && typeof parsed === "object" && typeof parsed.action === "string") logLine({ phase: "action", id: spawnId, action: parsed.action })
      if (parsed && typeof parsed === "object" && parsed.action && state.port) {
        const slot = typeof parsed.slot === "string" ? parsed.slot : undefined
        const port = slot ? (state.guestPorts?.[slot] ?? state.port) : state.port
        // A guest action that talks to OpenCode counts as one look at the waking server; `health` reads /proc only.
        const down =
          parsed.action !== "health" &&
          update((current) => {
            const target = current.machines.find((item) => item.id === machine.id)
            if (!target?.downPolls) return false
            target.downPolls -= 1
            return true
          })
        // A slot records this setup's port and then reaches its own server by it: a base on every later action would
        // make a helper that forgot the slot still read the right server, which is what the slot tests must catch.
        if (parsed.action !== "slots" && (slot === undefined || parsed.action === "setup")) {
          request = JSON.stringify({ ...parsed, base: `http://127.0.0.1:${down ? 1 : port}` })
        }
        // The loopback server stands for one this helper already started with no declared variables.
        if (parsed.action === "setup" && !down) {
          const names = slot ? join(root, HOME, ".boxd-plugin", "slots", slot, "env.json") : join(root, HOME, ".boxd-plugin", "env.json")
          if (!existsSync(names)) {
            mkdirSync(dirname(names), { recursive: true, mode: 0o700 })
            writeFileSync(names, "[]")
          }
        }
      }
    } catch {
      // Not JSON: the helper answers that itself.
    }
    result = spawnSync("python3", [join(root, helper[1]), ...(helper[2] ? ["--install"] : [])], { input: request, env, timeout: timeoutMs, encoding: "utf8", cwd: join(root, HOME) })
  } else {
    result = spawnSync("sh", ["-c", command], { input: readFileSync(0), env, timeout: timeoutMs, encoding: "utf8", cwd: join(root, HOME) })
  }
  const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM"
  const code = timedOut ? 124 : (result.status ?? 1)
  const stdout = result.stdout ?? ""
  const stderr = (result.stderr ?? "") + (timedOut ? `error: the command timed out after ${flags["--timeout"]} s\n` : "")
  if (flags["--json"]) {
    out({ output: stdout + stderr, exit_code: code })
    process.exit(0)
  }
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  process.exit(code)
}

function copy() {
  const [source, target] = positionals
  const remote = (spec) => {
    const at = spec.indexOf(":")
    return at > 0 && !spec.startsWith("/") ? { machine: spec.slice(0, at), path: spec.slice(at + 1) } : undefined
  }
  const state = read()
  const up = remote(target)
  const down = remote(source)
  if (up && !down) {
    const machine = must(state, region, up.machine)
    const path = toLocal(state, machine, up.path)
    if (!existsSync(source)) fail(`error: ${source}: no such file`)
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(source, path)
    process.stdout.write(`copied ${source} → ${target} (${statSync(path).size} bytes)\n`)
    return
  }
  if (down && !up) {
    const machine = must(state, region, down.machine)
    const path = toLocal(state, machine, down.path)
    if (!existsSync(path)) fail(`error: ${source}: no such file`)
    const cut = update((current) => current.cutCopies?.shift())
    if (cut === "silent") {
      // A copy that lands half the file and still exits 0.
      const bytes = readFileSync(path)
      writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)))
      process.stdout.write(`copied ${source} → ${target}\n`)
      return
    }
    if (cut) {
      // A copy cut off half-way: part of the file lands, and the CLI fails.
      const bytes = readFileSync(path)
      writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)))
      fail("error: connection reset during copy")
    }
    copyFileSync(path, target)
    process.stdout.write(`copied ${source} → ${target}\n`)
    return
  }
  fail("error: exactly one side of a copy must be vm:/path")
}

// ── The fake laptop `opencode`: the import pool's `session delete` and `session import` ────────────────────────────

function laptopOpencode() {
  const [group, action, value] = argv
  if (group !== "session" || !["delete", "import"].includes(action)) fail(`unsupported opencode command: ${argv.join(" ")}`)
  update((state) => {
    state.laptopSessions ??= {}
    if (action === "delete") {
      if (!state.laptopSessions[value]) fail(`Error: Session not found: ${value}`)
      delete state.laptopSessions[value]
      process.stdout.write(`Deleted session ${value}\n`)
      return
    }
    const exported = JSON.parse(readFileSync(value, "utf8"))
    const id = exported?.info?.id
    if (!id) fail("Error: not a session export")
    if (state.laptopSessions[id]) {
      process.stdout.write(`Session already exists: ${id}\n`)
      return
    }
    state.laptopSessions[id] = { title: exported.info.title ?? id, messages: exported.messages?.length ?? 0 }
    process.stdout.write(`Imported session: ${id}\n`)
  })
}

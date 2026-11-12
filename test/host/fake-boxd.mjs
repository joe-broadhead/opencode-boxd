#!/usr/bin/env node
// A fake boxd CLI for the host tests. It never touches a real machine: every command answers from a JSON state file,
// and `machine exec` runs the guest helper the plugin copied to the machine against a loopback fake of the guest
// OpenCode server.
//
// The state file (BOXD_FAKE_STATE) holds the machines, the snapshots, the guest port and a log of every call, which is
// how a test sees that a refused call ran nothing.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, normalize, sep } from "node:path"

const statePath = process.env.BOXD_FAKE_STATE
if (!statePath) {
  process.stderr.write("the fake boxd CLI needs BOXD_FAKE_STATE\n")
  process.exit(2)
}
/** The machine's /tmp/opencode-boxd/guest.py, kept beside the state file. A reboot clears /tmp, and a test deletes it. */
const HELPER = "/tmp/opencode-boxd/guest.py"
const helperCopy = join(dirname(statePath), "guest.py")

const read = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { machines: {}, snapshots: [], log: [], version: "2.2.6", port: 0 })
const write = (state) => {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

const argv = process.argv.slice(2)
const state = read()
// Every call is logged before it is answered, so a test can see what ran and what did not.
state.log.push(argv.join(" "))
write(state)

const machine = (name) => state.machines[name]

/**
 * A guest path under /home/boxd/work maps to a folder this test gave the machine. The work's own folder is a git
 * repository, as a prepared work tree is on a real machine, so `git status` reports the paths the plugin records.
 */
function fromGuest(path) {
  const prefix = "/home/boxd/work/"
  if (!path.startsWith(prefix)) fail(`unsupported guest path ${path}`)
  const [first, ...rest] = normalize(path.slice(prefix.length)).split(sep)
  if (!first || first === "..") fail(`bad guest path ${path}`)
  const base = state.guestDirectory
  if (!base) fail("the fake CLI has no guest directory")
  const root = join(base, first)
  mkdirSync(root, { recursive: true })
  if (!existsSync(join(root, ".git"))) {
    spawnSync("git", ["init", "--quiet", root])
    spawnSync("git", ["-C", root, "-c", "user.name=boxd test", "-c", "user.email=boxd@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "init"])
  }
  return join(root, ...rest)
}
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** The machine as boxd's `--json` prints it. A missing one is a not-found, which the plugin reads as missing. */
function printMachine(name) {
  const found = machine(name)
  if (!found) fail(`machine ${name} not found`)
  // The real `machine get --json`: isolation is the string "yes" or "no", not a boolean.
  out({
    name: found.name,
    id: `vm-${found.name}`,
    status: found.status,
    source: found.source ?? "standalone",
    auto_suspend: "off",
    auto_hibernate: "14400s",
    idle_ignore_outbound: "off",
    sharing: found.sharing,
    isolated: found.isolated ? "yes" : "no",
  })
}

function exec(name, command) {
  if (!machine(name)) fail(`machine ${name} not found`)
  if (command[0] === "opencode" && command[1] === "--version") {
    process.stdout.write(`opencode v${state.version}\n`)
    return
  }
  if (command[0] === "mkdir") return
  // `ls -1a /tmp`: the listing, with the helper's folder while the uploaded copy is there.
  if (command[0] === "ls" && command[1] === "-1a" && command[2] === "/tmp") {
    process.stdout.write([".", "..", ...(existsSync(helperCopy) ? ["opencode-boxd"] : []), "systemd-private-x"].join("\n") + "\n")
    return
  }
  if (command[0] === "python3") {
    // Python's own answer for a script that is not there: nothing runs, and stdout stays empty.
    if (command[1] !== HELPER || !existsSync(helperCopy)) {
      process.stderr.write(`python3: can't open file '${command[1]}': [Errno 2] No such file or directory\n`)
      process.exit(2)
    }
    const request = JSON.parse(readFileSync(0, "utf8") || "{}")
    // The guest helper talks to its own localhost OpenCode; here that is the test's loopback fake.
    request.base = `http://127.0.0.1:${state.port}`
    // The machine's `/home/boxd/work/<id>` is a folder on this laptop, so the real guest helper can work on it.
    if (typeof request.directory === "string") request.directory = fromGuest(request.directory)
    const result = spawnSync("python3", [helperCopy], { input: JSON.stringify(request), encoding: "utf8" })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  fail(`unsupported exec: ${command.join(" ")}`)
}

const [group, action, ...rest] = argv
if (group === "machine" && action === "new") {
  const name = rest[0]
  const snapshot = rest[rest.indexOf("--from-snapshot") + 1]
  if (rest.includes("--shared") || rest.includes("--isolated")) fail("the plugin must never ask for --shared or --isolated")
  state.machines[name] = { name, status: "running", sharing: "private", isolated: false, source: `snapshot/${snapshot}` }
  write(state)
  // The real `machine new --json` names the machine and its boot time, and nothing else: no status, sharing or isolation.
  out({ boot: "12ms", id: `vm-${name}`, name, paused_automations: 0, source: `snapshot/${snapshot}`, url: `${name}.boxd.sh` })
} else if (group === "machine" && action === "get") {
  printMachine(rest[0])
} else if (group === "machine" && action === "list") {
  out(Object.values(state.machines).map(({ name, status, sharing, isolated, source }) => ({
    name,
    status,
    sharing,
    isolated: isolated ? "yes" : "no",
    source: source ?? "standalone",
  })))
} else if (group === "machine" && action === "hibernate") {
  const found = machine(rest[0])
  if (!found) fail("not found")
  found.status = "hibernated"
  write(state)
  out(found)
} else if (group === "machine" && action === "wake") {
  const found = machine(rest[0])
  if (!found) fail("not found")
  found.status = "running"
  write(state)
  out(found)
} else if (group === "machine" && action === "remove") {
  const found = machine(rest[0])
  if (!found) fail("not found")
  found.status = "destroyed"
  write(state)
} else if (group === "machine" && action === "config") {
  out({ ok: true })
} else if (group === "machine" && action === "exec") {
  const name = rest[0]
  const command = rest.slice(1)
  if (command[0] === "--") command.shift()
  exec(name, command)
} else if (group === "machine" && action === "cp") {
  // `machine cp - machine:/path` writes stdin, and `machine cp machine:/path -` writes the file to stdout, byte for byte.
  const [source, target] = [rest[0], rest[1]]
  if (source === "-") {
    const remote = target.slice(target.indexOf(":") + 1)
    const path = remote === HELPER ? helperCopy : fromGuest(remote)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, readFileSync(0))
    process.stdout.write(`copied - → ${target} (${readFileSync(path).length} bytes)\n`)
  } else {
    const path = fromGuest(source.slice(source.indexOf(":") + 1))
    if (!existsSync(path)) fail(`${source}: no such file`)
    process.stdout.write(readFileSync(path))
  }
} else if (group === "snapshots" && action === "list") {
  out(state.snapshots)
} else if (group === "snapshots" && action === "save") {
  const [name, snapshot] = [rest[0], rest[1]]
  if (state.snapshots.some((item) => item.name === snapshot)) fail(`snapshot ${snapshot} already exists`)
  state.snapshots.push({ name: snapshot, storage: "local", status: "ready", machine: name })
  write(state)
  out({ ok: true })
} else {
  fail(`unsupported command: ${argv.join(" ")}`)
}
void join

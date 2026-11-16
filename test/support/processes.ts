// Whether a test's own process is still running, on Linux and macOS alike. A killed process can linger a moment as a
// zombie until its new parent reaps it, and `kill(pid, 0)` still answers for a zombie, so a zombie counts as gone; and
// the reaping is not instant on every system, so a check polls, with a bound, rather than sleeping a fixed time.
import { spawnSync } from "node:child_process"

/** True while `pid` exists and is not a zombie. `ps -o stat=` is the same on procps (Linux) and BSD (macOS). */
export function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()
  return stat !== "" && !stat.startsWith("Z")
}

/** Waits until none of `pids` is running, for at most `boundMs`; answers the ones still running then. */
export async function stillRunning(pids: readonly number[], boundMs = 5_000): Promise<number[]> {
  const deadline = Date.now() + boundMs
  for (;;) {
    const left = pids.filter(running)
    if (left.length === 0 || Date.now() > deadline) return left
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

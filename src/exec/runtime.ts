/**
 * Package A's entry (design §9.1): the runner, the boxd CLI port, the guest port and the laptop port. Package A owns
 * this file, `src/exec/*`, `src/boxd/*`, `src/guest/*` and `guest/guest.py`. `src/plugin.ts` calls `createRuntime` once.
 */
import type { BoxdPort, GuestPort, LaptopPort, Runner } from "../ports.js"
import { notBuilt, type HostServices, type Runtime } from "../services.js"

export function createRuntime(_host: HostServices): Runtime {
  return {
    runner: notBuilt<Runner>("runner"),
    boxd: notBuilt<BoxdPort>("boxd"),
    guest: notBuilt<GuestPort>("guest"),
    laptop: notBuilt<LaptopPort>("laptop"),
  }
}

import { Plugin } from "@opencode/plugin"
import { cliBoxd } from "./cli-boxd.js"
import { cliGuest } from "./cli-guest.js"
import { createFleet } from "./fleet.js"
import { Ledger } from "./ledger.js"
import { loadOptions } from "./options.js"
import { cliProver } from "./prover.js"
import { registerSkills } from "./skills.js"
import { registerTools } from "./tools.js"
import { checkHost } from "./version.js"

type Registration = { dispose(): Promise<void> }

export default Plugin.define({
  id: "boxd",
  async setup(ctx) {
    const options = loadOptions(ctx.options)
    checkHost(ctx.app.version, options.allowUntestedHost)
    const fleet = createFleet({
      boxd: cliBoxd(options.boxd),
      guest: cliGuest(options.boxd),
      prover: cliProver(),
      ledger: new Ledger(options.ledger),
      now: () => new Date().toISOString(),
      snapshot: options.snapshot,
    })
    const registrations: Registration[] = []
    try {
      registrations.push(await registerSkills(ctx))
      registrations.push(await registerTools(ctx, fleet))
    } catch (error) {
      for (const registration of registrations.splice(0).reverse()) await registration.dispose()
      throw error
    }
    return async () => {
      for (const registration of registrations.splice(0).reverse()) await registration.dispose()
    }
  },
})

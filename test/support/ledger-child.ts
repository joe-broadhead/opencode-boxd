// A second OpenCode process for the ledger and import tests: the parent runs this file with bun and kills it, races
// it, or waits for it. `import` stops itself with SIGKILL at the step it is given, as a crash would.
import { runImport, LedgerGate, type ImportStep } from "../../src/import-v0.js"
import { Ledger } from "../../src/ledger/store.js"
import { fakeImportBoxd } from "./ledger-fakes.js"

const [mode, root, ...rest] = process.argv.slice(2)

if (mode === "import") {
  const [step, count] = rest
  const outcome = await runImport({
    root: root!,
    boxd: fakeImportBoxd(),
    onStep: (name: ImportStep, progress) => {
      if (name === step && (name !== "record" || progress.done === Number(count))) process.kill(process.pid, "SIGKILL")
    },
  })
  console.log(JSON.stringify(outcome))
} else if (mode === "gate") {
  const gate = new LedgerGate({ root: root!, boxd: fakeImportBoxd() })
  console.log(JSON.stringify(await gate.start()))
} else if (mode === "mutate") {
  const [workId, tag, count] = rest
  const ledger = new Ledger(root!, { lockWaitMs: 30_000 })
  for (let index = 0; index < Number(count); index++) {
    await ledger.mutate(workId!, (current) => current && { ...current, reboots: [...(current.reboots ?? []), { at: `${tag}-${index}`, why: "repair" }] })
  }
  console.log("ok")
} else if (mode === "pair") {
  const [first, second, count] = rest
  const ledger = new Ledger(root!, { lockWaitMs: 30_000 })
  for (let index = 0; index < Number(count); index++) {
    await ledger.withWorks([first!, second!], async () => {
      for (const id of [first!, second!]) {
        await ledger.mutate(id, (current) => current && { ...current, reboots: [...(current.reboots ?? []), { at: `${first}>${second}-${index}`, why: "repair" }] })
      }
    })
  }
  console.log("ok")
} else if (mode === "events") {
  const [tag, count] = rest
  const ledger = new Ledger(root!)
  for (let index = 0; index < Number(count); index++) await ledger.events.append({ workId: "events-work", from: null, to: "busy", code: tag })
  console.log("ok")
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}

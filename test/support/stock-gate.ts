/**
 * The gate for a host test on one tested OpenCode release. The stock binary is either there, and the test runs, or it is
 * missing. A laptop skips that release and says so in the output. CI fails, because a tested release that did not run
 * is not evidence (PUBLIC-PATTERN R34): nothing skips silently in CI.
 *
 * Use it in place of a test that only reports a missing version, or that skips without a word:
 *
 *   const gate = stockGate(version, binary(version), available(version))
 *   describe.skipIf(gate === "skip")(`the host on stock OpenCode ${version}`, () => { ... })
 */
export type StockGate = "run" | "skip"

/** True when the environment says this is a CI run. */
export const inCi = (env: Record<string, string | undefined> = process.env) => env.CI === "true" || env.CI === "1"

export function stockGate(version: string, binaryPath: string, found: boolean, env: Record<string, string | undefined> = process.env): StockGate {
  if (found) return "run"
  const variable = `OPENCODE_BIN_${version.replaceAll(".", "_")}`
  if (inCi(env)) {
    throw new Error(
      `stock OpenCode ${version} is missing at ${binaryPath}, so this tested release did not run. In CI a skipped tested release is a failure: install the stock host, or set ${variable}.`,
    )
  }
  console.log(`skip: no stock OpenCode ${version} at ${binaryPath}; set ${variable} to run it`)
  return "skip"
}

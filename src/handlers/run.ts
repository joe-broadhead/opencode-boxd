/** One handler call's shared plumbing: the contract's error form, the call context, and the `changed` nudge after a write. */
import type { MethodCall, MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { CallContext } from "../call.js"
import type { ListResult, Refusal } from "../results.js"
import { contractFailure, contractRefusal } from "./refusals.js"

/** The capability a write nudges: the works source, whose reads list every work. */
export const CHANGED_CAPABILITY = "boxd.works"

/** A method call as the runs know it: the same session, signal and door, without the register's account and plan. */
export function callOf(call: MethodCall, matched?: readonly string[]): CallContext {
  return {
    sessionID: call.sessionID,
    agent: call.agent,
    messageID: call.messageID,
    id: call.id,
    signal: call.signal,
    via: call.door === "rpc" ? "rpc" : "model",
    ...(matched === undefined ? {} : { matched }),
  }
}

const isRefusal = (value: unknown): value is Refusal =>
  typeof value === "object" && value !== null && "error" in value && "message" in value && "next" in value && "state" in value

/** A run's answer: its success value or list envelope; a refusal becomes the contract's error form. */
export async function settle<T extends { readonly state: string }>(work: () => Promise<T | Refusal | ListResult<T>>): Promise<T | ListResult<T>> {
  const value = await work()
  if (isRefusal(value)) throw contractRefusal(value)
  return value
}

/** Run one handler body, with any internal failure mapped to the contract's error form. */
export async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw contractFailure(error)
  }
}

/** Emit the contract's `changed` nudge after a write. A lost nudge is a re-read, never lost data. */
export async function nudge(call: MethodCall): Promise<void> {
  await call.bus?.emit("changed", { capability: CHANGED_CAPABILITY, account: call.account, reason: "write" })
}

/** A handler with a fixed description, schemas and run. */
export const method = (description: string, input: MethodHandler["input"], output: MethodHandler["output"], run: MethodHandler["run"]): MethodHandler => ({ description, input, output, run })

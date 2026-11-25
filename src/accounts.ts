/**
 * The local account (contract §5): this machine and the OS user running OpenCode.
 *
 * `accounts.via` is `local`, so there is exactly one account, `default`, and its owner is the machine's identity,
 * `os-user:<user>@<host>`. Nothing here signs in, stores a credential or touches the boxd CLI's own sign-in: that
 * belongs to the person and the CLI.
 */
import type { Owner } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { localIdentity, type AccountProfile } from "@we-the-rebel-alliance/plugin-contract/accounts"

/** The one account alias a local plugin has. */
export const LOCAL_ALIAS = "default"

export interface MachineIdentity {
  /** `os-user:<user>@<host>`, the owner id a probe answers and a host keys its cache on. */
  readonly id: string
  /** One line for a person: `<user> on <host>`. */
  readonly label: string
}

/** The owner for a local identity id, with each part cut to one line. */
export function identityOf(id: string): MachineIdentity {
  const rest = id.startsWith("os-user:") ? id.slice("os-user:".length) : id
  const at = rest.lastIndexOf("@")
  const user = at > 0 ? rest.slice(0, at) : rest
  const host = at > 0 ? rest.slice(at + 1) : "this machine"
  return { id, label: `${line(user) || "user"} on ${line(host) || "this machine"}` }
}

const line = (text: string): string => text.replace(/\p{Cc}+/gu, "").replace(/\s+/g, " ").trim().slice(0, 120)

/** This process's machine identity. */
export const machineIdentity = (): MachineIdentity => identityOf(localIdentity())

/** The owner a status and a probe answer, from an identity. */
export const ownerOf = (identity: MachineIdentity): Owner => ({ id: identity.id, label: identity.label })

/** The one local account of a plan, or `undefined` when the manifest declares none. */
export const localAccount = (accounts: readonly AccountProfile[]): AccountProfile | undefined => accounts.find((account) => account.alias === LOCAL_ALIAS)

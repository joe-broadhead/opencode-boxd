/**
 * The local machine identity: this machine and the OS user running OpenCode.
 *
 * The plugin declares no accounts and holds no credential; the identity, `os-user:<user>@<host>`, is what probe reports.
 * The boxd CLI's own sign-in belongs to the person and the CLI.
 */
import type { Owner } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { localIdentity } from "@we-the-rebel-alliance/plugin-contract/accounts"

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

/** A fresh temporary root outside the repository, and its removal. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const tempRoot = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)))

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

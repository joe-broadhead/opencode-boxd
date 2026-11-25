/**
 * The v1 guest helper as the laptop ships it: `guest/guest.py` in the package, its sha256 (which a change sends, so an
 * older copy on the machine refuses to act and is replaced), and where an upload lands before it installs itself at
 * the stable path `GUEST_HELPER_PATH`.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

/** Where `machine cp` puts a new helper: the guest's home, which always exists. `--install` moves it from there. */
export const HELPER_UPLOAD_PATH = "/home/boxd/.boxd-plugin-upload.py"

export interface HelperFile {
  readonly path: string
  readonly sha256: string
}

/**
 * The package's `guest/guest.py`. The bundle (`dist/index.js`), `src/provider/index.ts` and this source file sit at
 * different depths below the package root, so every place is looked at; the first that exists is the package's copy.
 */
export function packagedHelperPath(): string {
  const candidates = [new URL("../guest/guest.py", import.meta.url), new URL("../../../guest/guest.py", import.meta.url)].map((url) => fileURLToPath(url))
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new Error("The plugin's guest/guest.py is missing from the package. Reinstall the plugin.")
  return found
}

const cache = new Map<string, Promise<HelperFile>>()

/** The helper's path and sha256, read once per path. */
export function helperFile(path: string = packagedHelperPath()): Promise<HelperFile> {
  let file = cache.get(path)
  if (!file) {
    file = readFile(path).then((bytes) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex") }))
    file.catch(() => cache.delete(path))
    cache.set(path, file)
  }
  return file
}

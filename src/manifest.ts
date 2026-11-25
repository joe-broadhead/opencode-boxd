/**
 * The installed manifest: `capabilities` from `package.json`, the one declaration apps, the catalog and the kit read.
 *
 * The bundle inlines this file's JSON import at build time, so the runtime manifest and the installed `package.json`
 * are one value; the hash a grant stores is computed from it.
 */
import pkg from "../package.json" with { type: "json" }
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"

export const PACKAGE: string = pkg.name
export const VERSION: string = pkg.version
export const manifest = pkg.capabilities as unknown as Manifest

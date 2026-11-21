// The relay is built from this folder alone, so it holds copies of the two
// modules it shares with the bridge. Run this after changing either one.
import { copyFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
for (const f of ["frame.ts", "initdata.ts"])
  copyFileSync(join(here, "../../src/link", f), join(here, "../src/shared", f))

/** The Mini App's static files, served by the bridge: one origin, one version. */
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import type { ServerResponse } from "node:http"

const ROOT = new URL("../../miniapp/", import.meta.url)
const FILE = /^[a-z0-9-]+\.(html|js|css|svg)$/
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
}

const TELEGRAM = [
  "https://web.telegram.org",
  "https://webk.telegram.org",
  "https://webz.telegram.org",
]

/** Telegram's own script, the only one from another origin: it is what a Mini App uses to reach the client. */
export const TELEGRAM_SDK = "https://telegram.org/js/telegram-web-app.js"

/** No style or font from another origin, no script but Telegram's; framing only by Telegram's web clients. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self' https://telegram.org",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors " + TELEGRAM.join(" "),
].join("; ")

const HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
}

const NEVER = "no-store"
const FOREVER = "public, max-age=31536000, immutable"

let stamped: { version: string; value: Promise<string> } | undefined

/**
 * The build of the app files: the bridge version and a hash of the files. It goes into every file
 * URL, so a phone, Telegram's WebView or a CDN that kept an older copy asks for a URL it has not
 * got. Read once per process, like the version.
 */
export function appStamp(version: string): Promise<string> {
  if (stamped?.version !== version)
    stamped = {
      version,
      value: (async () => {
        const hash = createHash("sha256")
        for (const f of (await readdir(ROOT))
          .filter((n) => FILE.test(n))
          .sort())
          hash.update(f).update(await readFile(new URL(f, ROOT)))
        return `${version}-${hash.digest("hex").slice(0, 8)}`
      })(),
    }
  return stamped.value
}

/** Every file the page or a module names by a relative URL gets the stamp, so no import is old. */
function stampUrls(name: string, text: string, stamp: string): string {
  if (name.endsWith(".html"))
    return text.replace(
      /\b(href|src)="([a-z0-9-]+\.(?:js|css|svg))"/g,
      `$1="$2?v=${stamp}"`,
    )
  if (name.endsWith(".js"))
    return text.replace(/(\bfrom\s+"\.\/[a-z0-9-]+\.js)"/g, `$1?v=${stamp}"`)
  return text
}

/**
 * Serves `/app/` or `/app/<file>`; any other name is 404. The page is never kept. A file asked for
 * with the current stamp may be kept for good, because the next build has another URL; one asked for
 * without it, or with an old one, is current but is not kept.
 */
export async function serveApp(
  pathname: string,
  res: ServerResponse,
  version: string,
  asked?: string | null,
): Promise<void> {
  const name =
    pathname === "/app/" ? "index.html" : pathname.slice("/app/".length)
  const raw = FILE.test(name)
    ? await readFile(new URL(name, ROOT)).catch(() => undefined)
    : undefined
  if (!raw) {
    res.writeHead(404, { "content-type": "text/plain", ...HEADERS })
    return void res.end("not found")
  }
  const stamp = await appStamp(version)
  const keep = !name.endsWith(".html") && asked === stamp
  res.writeHead(200, {
    "content-type": TYPES[name.slice(name.lastIndexOf(".") + 1)],
    "cache-control": keep ? FOREVER : NEVER,
    ...HEADERS,
  })
  res.end(stampUrls(name, raw.toString("utf8"), stamp))
}

/** The Mini App's static files, served by the bridge: one origin, one version. */
import { readFile } from "node:fs/promises"
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

/** No script, style or font from another origin; framing only by Telegram's web clients. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
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
  "cache-control": "no-cache",
}

/** Serves `/app/` or `/app/<file>`; any other name is 404. */
export async function serveApp(
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  const name =
    pathname === "/app/" ? "index.html" : pathname.slice("/app/".length)
  const body = FILE.test(name)
    ? await readFile(new URL(name, ROOT)).catch(() => undefined)
    : undefined
  if (!body) {
    res.writeHead(404, { "content-type": "text/plain", ...HEADERS })
    return void res.end("not found")
  }
  res.writeHead(200, {
    "content-type": TYPES[name.slice(name.lastIndexOf(".") + 1)],
    ...HEADERS,
  })
  res.end(body)
}

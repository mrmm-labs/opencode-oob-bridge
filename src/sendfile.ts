/** The agent tool `oob_send_file`: which files may leave, and how they are sent. Never reads or logs contents here. */
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname, resolve, sep } from "node:path"

export const TOOL_NAME = "oob_send_file"
/** The Bot API cap for an uploaded file. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** The Bot API cap for a photo. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024
export const CAPTION_MAX = 1024

const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
}

export type FileKind = "photo" | "document"

/** A file checked and ready: `read` loads it only when a connector has a place to send it. */
export type FileJob = {
  name: string
  kind: FileKind
  type: string
  size: number
  read(): Promise<Uint8Array>
}

export type FileOutcome =
  | { ok: true; message: string }
  | { ok: false; error: string }
export type Prepared =
  | { ok: true; file: FileJob }
  | { ok: false; error: string }

const mb = (n: number) => (n / (1024 * 1024)).toFixed(1) + " MB"

/** Checks a path and the `as` choice. A symlink must stay inside the home directory; anything but a regular file is refused. */
export async function prepareFile(o: {
  path: unknown
  as?: unknown
  cwd?: string
  home?: string
}): Promise<Prepared> {
  const as = o.as ?? "auto"
  if (as !== "auto" && as !== "photo" && as !== "document")
    return { ok: false, error: "as must be photo, document or auto" }
  if (typeof o.path !== "string" || o.path.trim() === "")
    return { ok: false, error: "path is required" }
  const home = o.home ?? homedir()
  const raw = o.path.trim()
  const path = resolve(
    o.cwd ?? process.cwd(),
    raw === "~" || raw.startsWith("~/") ? home + raw.slice(1) : raw,
  )
  let real = path
  try {
    const l = await lstat(path)
    if (l.isSymbolicLink()) {
      real = await realpath(path)
      const root = await realpath(home).catch(() => home)
      if (real !== root && !real.startsWith(root + sep))
        return {
          ok: false,
          error: "a symlink pointing outside your home is refused",
        }
    }
    const s = await stat(real)
    if (s.isDirectory()) return { ok: false, error: "that is a directory" }
    if (!s.isFile()) return { ok: false, error: "that is not a regular file" }
    if (s.size > MAX_FILE_BYTES)
      return {
        ok: false,
        error: `file is ${mb(s.size)}, over the ${mb(MAX_FILE_BYTES)} limit`,
      }
    const image = IMAGES[extname(path).toLowerCase()]
    if (as === "photo" && !image)
      return { ok: false, error: "only png, jpg and webp can go as a photo" }
    if (as === "photo" && s.size >= MAX_PHOTO_BYTES)
      return {
        ok: false,
        error: "a photo must be under 10 MB; use as: document",
      }
    const kind: FileKind =
      as === "photo" || (as === "auto" && image && s.size < MAX_PHOTO_BYTES)
        ? "photo"
        : "document"
    const size = s.size
    return {
      ok: true,
      file: {
        name: basename(path),
        kind,
        type: image ?? "application/octet-stream",
        size,
        async read() {
          const data = await readFile(real)
          if (data.length > MAX_FILE_BYTES)
            throw new Error("file grew past the limit")
          return data
        },
      },
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      ok: false,
      error: code === "ENOENT" ? "file not found" : "cannot read that file",
    }
  }
}

export const TOOL_DESCRIPTION =
  "Send a local file to the Telegram topic of this session (images under 10 MB as a photo, everything else as a document; up to 50 MB). Fails when the session has no topic."

/** The tool the host registers: `send` is given the calling session and the raw input. */
export const fileTool = (
  send: (
    sessionID: string,
    input: Record<string, unknown>,
  ) => Promise<FileOutcome>,
) => ({
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to send" },
      caption: {
        type: "string",
        description: "Optional caption (1024 characters at most)",
      },
      as: {
        type: "string",
        enum: ["photo", "document", "auto"],
        description:
          "auto (default): images under 10 MB as a photo, the rest as a document",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async (input: Record<string, unknown>, c: { sessionID: string }) => {
    const r = await send(c.sessionID, input ?? {})
    return r.ok
      ? { content: r.message }
      : { content: "Error: " + r.error, metadata: { error: true } }
  },
})

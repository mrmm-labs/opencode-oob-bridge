/**
 * Files sent to the bot: which messages carry one, what is accepted, and how it
 * is downloaded. Nothing here talks to a session; the connector hands the
 * result on as an inbound file.
 */

export const DEFAULT_MEDIA_MAX = 10 * 1024 * 1024
/** What `getFile` can serve: larger files cannot be downloaded from the public Bot API at all. */
export const BOT_API_MAX = 20 * 1024 * 1024
const DOWNLOAD_MS = 30_000

export const DEFAULT_MEDIA_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]

export type MediaConfig = {
  /** Largest file taken, in bytes. */
  maxBytes: number
  /** Accepted mime types; `type/*` takes a whole family. */
  mimes: string[]
}

export const DEFAULT_MEDIA: MediaConfig = {
  maxBytes: DEFAULT_MEDIA_MAX,
  mimes: DEFAULT_MEDIA_MIMES,
}

const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/(?:[a-z0-9][a-z0-9.+-]*|\*)$/

export function parseMedia(
  raw: unknown,
  at: string,
): { media: MediaConfig } | { error: string } {
  if (raw === undefined) return { media: DEFAULT_MEDIA }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: `${at}media must be an object` }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o))
    if (k !== "maxBytes" && k !== "mimes")
      return { error: `${at}media.${k} is not a setting (use maxBytes, mimes)` }
  const maxBytes = o.maxBytes ?? DEFAULT_MEDIA_MAX
  if (
    typeof maxBytes !== "number" ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > BOT_API_MAX
  )
    return {
      error: `${at}media.maxBytes must be a whole number of bytes, 1 to ${BOT_API_MAX} (Telegram serves no more)`,
    }
  let mimes = DEFAULT_MEDIA_MIMES
  if (o.mimes !== undefined) {
    if (
      !Array.isArray(o.mimes) ||
      o.mimes.some((m) => typeof m !== "string" || !MIME_RE.test(m))
    )
      return {
        error: `${at}media.mimes must be a list of lower-case mime types such as "application/pdf" or "image/*"`,
      }
    mimes = o.mimes as string[]
  }
  return { media: { maxBytes, mimes } }
}

export const mimeAllowed = (mime: string, cfg: MediaConfig) =>
  cfg.mimes.some((m) =>
    m.endsWith("/*") ? mime.startsWith(m.slice(0, -1)) : m === mime,
  )

/** What a message holds that is worth fetching. */
export type MediaRef =
  | {
      kind: "photo" | "document"
      fileId: string
      size?: number
      mime?: string
      name?: string
    }
  | { kind: "unsupported" }

export type MediaMessage = {
  photo?: Array<{
    file_id: string
    file_size?: number
    width?: number
    height?: number
  }>
  document?: {
    file_id: string
    file_name?: string
    mime_type?: string
    file_size?: number
  }
  voice?: unknown
  video?: unknown
  video_note?: unknown
  audio?: unknown
  animation?: unknown
}

export function mediaOf(m: MediaMessage): MediaRef | undefined {
  if (m.photo?.length) {
    // Telegram lists the same picture in growing sizes: the last is the largest.
    const best = [...m.photo].sort(
      (a, b) =>
        (a.file_size ?? (a.width ?? 0) * (a.height ?? 0)) -
        (b.file_size ?? (b.width ?? 0) * (b.height ?? 0)),
    )[m.photo.length - 1]
    return {
      kind: "photo",
      fileId: best.file_id,
      size: best.file_size,
      mime: "image/jpeg",
    }
  }
  if (m.document)
    return {
      kind: "document",
      fileId: m.document.file_id,
      size: m.document.file_size,
      mime: m.document.mime_type?.split(";")[0].trim().toLowerCase(),
      name: m.document.file_name,
    }
  if (m.voice || m.video || m.video_note || m.audio || m.animation)
    return { kind: "unsupported" }
  return undefined
}

/** A file that is refused; the message is for the person who sent it. */
export class MediaRejected extends Error {}

export const megabytes = (n: number) =>
  `${Math.round((n / 1024 / 1024) * 10) / 10} MB`

/** Checks the size Telegram announced, before anything is downloaded. */
export function checkAnnounced(
  ref: Extract<MediaRef, { kind: "photo" | "document" }>,
  cfg: MediaConfig,
  /** A type the model cannot take inline goes to the session's file inbox instead of being refused. */
  inbox = false,
): void {
  if (ref.size !== undefined && ref.size > cfg.maxBytes)
    throw new MediaRejected(
      `That file is ${megabytes(ref.size)}; the limit is ${megabytes(cfg.maxBytes)}.`,
    )
  if (ref.kind === "document") {
    if (!inbox && (!ref.mime || !mimeAllowed(ref.mime, cfg)))
      throw new MediaRejected(
        `Files of type ${ref.mime ?? "unknown"} are not accepted. Accepted: ${cfg.mimes.join(", ")}.`,
      )
  } else if (!mimeAllowed("image/jpeg", cfg))
    throw new MediaRejected("Photos are not accepted.")
}

const starts = (b: Uint8Array, sig: number[], at = 0) =>
  sig.every((v, i) => b[at + i] === v)

/** The type the first bytes show, for the kinds that have a signature. */
export function sniff(b: Uint8Array): string | undefined {
  if (starts(b, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png"
  if (starts(b, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (
    starts(b, [0x52, 0x49, 0x46, 0x46]) &&
    starts(b, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp"
  if (starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  return undefined
}

const isText = (mime: string) =>
  mime.startsWith("text/") || mime === "application/json"

/**
 * The type to give the session. A declared type is only a claim: pictures and
 * PDFs must start like one, text must be UTF-8 with no NUL bytes.
 */
export function verify(
  ref: Extract<MediaRef, { kind: "photo" | "document" }>,
  bytes: Uint8Array,
  cfg: MediaConfig,
): string {
  if (bytes.length === 0) throw new MediaRejected("That file is empty.")
  if (bytes.length > cfg.maxBytes)
    throw new MediaRejected(
      `That file is larger than the limit of ${megabytes(cfg.maxBytes)}.`,
    )
  const found = sniff(bytes)
  const declared = ref.mime!
  if (ref.kind === "photo") {
    if (!found?.startsWith("image/") || !mimeAllowed(found, cfg))
      throw new MediaRejected("That does not look like a picture.")
    return found
  }
  if (found) {
    if (found !== declared)
      throw new MediaRejected(`That file is not really ${declared}.`)
    return found
  }
  if (isText(declared)) {
    const head = bytes.subarray(0, 8192)
    if (head.includes(0))
      throw new MediaRejected(`That file is not really ${declared}.`)
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new MediaRejected("Text files must be UTF-8.")
    }
    return declared
  }
  if (declared.startsWith("image/") || declared === "application/pdf")
    throw new MediaRejected(`That file is not really ${declared}.`)
  // A type the operator added to the allowlist and that has no signature check.
  return declared
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
}

/** A name safe to show: no path, no control characters, not long. */
export function fileName(
  ref: Extract<MediaRef, { kind: "photo" | "document" }>,
  mime: string,
  id: string,
): string {
  const clean = (ref.name ?? "")
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 80)
  return clean || `${ref.kind}-${id}.${EXT[mime] ?? "bin"}`
}

/** Whether a document goes inline as a file part; any other type is saved for the session to read itself. */
export const takenInline = (
  ref: Extract<MediaRef, { kind: "photo" | "document" }>,
  cfg: MediaConfig,
): boolean => ref.kind === "photo" || (!!ref.mime && mimeAllowed(ref.mime, cfg))

/** A name safe on disk: no path, no odd characters, not long, the original extension kept. */
export function safeFileName(name: string | undefined, id: string): string {
  const base = (name ?? "").split(/[\\/]/).pop()!
  const dot = base.lastIndexOf(".")
  const ext =
    dot > 0
      ? base
          .slice(dot)
          .replace(/[^A-Za-z0-9.]/g, "")
          .slice(0, 12)
      : ""
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/\.{2,}/g, "_")
    .trim()
    .slice(0, 80)
  return `${id}-${stem || "file"}${ext === "." ? "" : ext}`
}

/** "512 bytes", "3.4 KB", "2.1 MB". */
export const sizeText = (n: number): string =>
  n < 1024
    ? `${n} bytes`
    : n < 1024 * 1024
      ? `${Math.round(n / 102.4) / 10} KB`
      : megabytes(n)

/** Reads a response body, giving up past `max` bytes instead of trusting any announced size. */
export async function readCapped(
  res: Response,
  max: number,
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const parts: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > max) {
        await reader.cancel()
        throw new MediaRejected(
          `That file is larger than the limit of ${megabytes(max)}.`,
        )
      }
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Downloads `file_path` from the Bot API file endpoint. The URL holds the token and is never put in a message. */
export async function download(o: {
  fetch: typeof fetch
  base: string
  token: string
  filePath: string
  maxBytes: number
  signal?: AbortSignal
}): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(DOWNLOAD_MS)
  const res = await o.fetch(
    `${o.base}/file/bot${o.token}/${o.filePath.replace(/^\/+/, "")}`,
    { signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout },
  )
  if (!res.ok)
    throw new Error(`telegram file download failed: HTTP ${res.status}`)
  return readCapped(res, o.maxBytes)
}

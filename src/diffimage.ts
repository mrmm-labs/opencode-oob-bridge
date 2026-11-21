import { filterSecrets } from "./filter.ts"
import { glyph, WRAP_MARK } from "./font.ts"
import { encodePng, type Rgb } from "./png.ts"
import { globToRegExp } from "./routing.ts"

export type DiffFile = {
  file: string
  status: string
  additions: number
  deletions: number
  patch: string
}

export type DiffTheme = "dark" | "light"

export type DiffOptions = {
  /** Globs of files that are named and not drawn. */
  exclude: string[]
  theme: DiffTheme
  /** Applied to every file name that is shown. */
  name?: (file: string) => string
}

export const DEFAULT_EXCLUDE = [
  "**/.env*",
  "**/*.pem",
  "**/*secret*",
  "**/id_*",
]

/** 56 columns of 16 px: a phone shows the image about 390 pt wide. */
export const COLUMNS = 56
const NUMBER_COLS = 4
const TEXT_COLS = COLUMNS - NUMBER_COLS - 1
const CELL_W = 16
const CELL_H = 32
const PAD_X = 2
const PAD_Y = 4
export const IMAGE_WIDTH = COLUMNS * CELL_W + 2 * PAD_X
/**
 * Telegram shrinks a photo longer than 1280 px, which would make the text
 * unreadable; 38 rows of 32 px and the padding stay under it.
 */
export const ROWS_PER_IMAGE = 38
export const MAX_IMAGES = 3
export const MAX_PATCH_BYTES = 20 * 1024 * 1024

type Kind = "file" | "hunk" | "add" | "del" | "ctx" | "note"
type Row = {
  kind: Kind
  /** One code point a cell. */
  text: string[]
  number?: number
  /** Continues the row above. */
  cont?: boolean
}

// Indices into the palette.
const BG = 0
const ADD = 1
const DEL = 2
const FILE = 3
const HUNK = 4
const FG = 5
const GUTTER = 6
const HDR = 7

const hex = (s: string): Rgb => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
]

const PALETTES: Record<DiffTheme, string[]> = {
  dark: [
    "#0d1117",
    "#0f3d1f",
    "#4a1519",
    "#1f4e8c",
    "#16273d",
    "#e6edf3",
    "#b1bac4",
    "#ffffff",
  ],
  light: [
    "#ffffff",
    "#ccf0d3",
    "#ffd7d5",
    "#0550ae",
    "#ddf4ff",
    "#1f2328",
    "#57606a",
    "#ffffff",
  ],
}

export function palette(theme: DiffTheme): Rgb[] {
  return PALETTES[theme].map(hex)
}

/** The text and background colours that are drawn together. */
export const COLOUR_PAIRS: Array<[text: number, background: number]> = [
  [FG, BG],
  [FG, ADD],
  [FG, DEL],
  [FG, HUNK],
  [GUTTER, BG],
  [GUTTER, ADD],
  [GUTTER, DEL],
  [HDR, FILE],
]

const BACKGROUND: Record<Kind, number> = {
  file: FILE,
  hunk: HUNK,
  add: ADD,
  del: DEL,
  ctx: BG,
  note: BG,
}

const matchers = (exclude: string[]) => exclude.map(globToRegExp)

const hidden = (file: string, re: RegExp[]) => {
  const f = file.replace(/\\/g, "/")
  return re.some((r) => r.test(f))
}

const BINARY = /^Binary files .* differ$|^GIT binary patch/m
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function header(f: DiffFile, name: string): string {
  const status = !f.status || f.status === "modified" ? "" : f.status + " "
  return `${status}${name} +${f.additions} -${f.deletions}`
}

/** Splits a line over rows of `first` cells, then `rest` cells; the continuations are marked. */
function wrap(kind: Kind, text: string, width: number, number?: number): Row[] {
  const cells = Array.from(text.replace(/\r/g, "").replace(/\t/g, "    "))
  const rows: Row[] = []
  for (let i = 0; i === 0 || i < cells.length; i += width)
    rows.push({
      kind,
      text: cells.slice(i, i + width),
      number: i === 0 ? number : undefined,
      cont: i > 0 || undefined,
    })
  return rows
}

function rowsOf(f: DiffFile, o: DiffOptions, re: RegExp[]): Row[] {
  const name = o.name ? o.name(f.file) : f.file
  const out = wrap("file", header(f, name), COLUMNS)
  if (hidden(f.file, re))
    return [...out, ...wrap("note", "content hidden", COLUMNS)]
  const patch = filterSecrets(f.patch)
  if (BINARY.test(patch) || (!patch.trim() && !f.additions && !f.deletions))
    return [...out, ...wrap("note", "binary, not shown", COLUMNS)]
  let oldAt = 0
  let newAt = 0
  let inHunk = false
  const lines = patch.split("\n")
  lines.forEach((line, i) => {
    const h = HUNK_HEAD.exec(line)
    if (h) {
      oldAt = Number(h[1])
      newAt = Number(h[2])
      inHunk = true
      out.push(...wrap("hunk", line, COLUMNS))
    } else if (!inHunk || line.startsWith("\\")) return
    else if (line.startsWith("+"))
      out.push(...wrap("add", line.slice(1), TEXT_COLS, newAt++))
    else if (line.startsWith("-"))
      out.push(...wrap("del", line.slice(1), TEXT_COLS, oldAt++))
    else if (line.startsWith(" ") || (line === "" && i < lines.length - 1)) {
      out.push(...wrap("ctx", line.slice(1), TEXT_COLS, newAt++))
      oldAt++
    }
  })
  return out
}

function paint(rows: Row[]): {
  width: number
  height: number
  pixels: Uint8Array
} {
  const width = IMAGE_WIDTH
  const height = rows.length * CELL_H + 2 * PAD_Y
  const pixels = new Uint8Array(width * height) // BG is 0
  const cell = (col: number, rowAt: number, ch: string, color: number) => {
    const g = glyph(ch.codePointAt(0) ?? 0x20)
    const x0 = PAD_X + col * CELL_W
    const y0 = PAD_Y + rowAt * CELL_H
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 8; x++)
        if (g[y] & (0x80 >> x))
          for (let dy = 0; dy < 2; dy++)
            pixels.fill(
              color,
              (y0 + y * 2 + dy) * width + x0 + x * 2,
              (y0 + y * 2 + dy) * width + x0 + x * 2 + 2,
            )
  }
  rows.forEach((r, i) => {
    const bg = BACKGROUND[r.kind]
    if (bg !== BG)
      pixels.fill(
        bg,
        (PAD_Y + i * CELL_H) * width,
        (PAD_Y + (i + 1) * CELL_H) * width,
      )
    const wide = r.kind === "file" || r.kind === "hunk" || r.kind === "note"
    const color = r.kind === "file" ? HDR : r.kind === "note" ? GUTTER : FG
    if (wide) {
      const text = r.cont ? [WRAP_MARK, ...r.text] : r.text
      text.slice(0, COLUMNS).forEach((ch, c) => cell(c, i, ch, color))
      return
    }
    if (r.number !== undefined)
      String(r.number)
        .slice(-NUMBER_COLS)
        .padStart(NUMBER_COLS)
        .split("")
        .forEach((ch, c) => cell(c, i, ch, GUTTER))
    const marker = r.cont
      ? WRAP_MARK
      : r.kind === "add"
        ? "+"
        : r.kind === "del"
          ? "-"
          : " "
    cell(NUMBER_COLS, i, marker, FG)
    r.text.forEach((ch, c) => cell(NUMBER_COLS + 1 + c, i, ch, FG))
  })
  return { width, height, pixels }
}

export type Drawn = {
  images: Uint8Array[]
  /** Lines that did not fit in the images; they are only in the patch. */
  omitted: number
}

/** Draws the diff as up to three phone-sized PNGs. */
export async function drawDiff(
  files: DiffFile[],
  o: DiffOptions,
  encode: typeof encodePng = encodePng,
): Promise<Drawn> {
  const re = matchers(o.exclude)
  const rows = files.flatMap((f) => rowsOf(f, o, re))
  const pages: Row[][] = []
  for (let i = 0; i < rows.length; i += ROWS_PER_IMAGE)
    pages.push(rows.slice(i, i + ROWS_PER_IMAGE))
  const shown = pages.slice(0, MAX_IMAGES)
  const images: Uint8Array[] = []
  for (const page of shown) {
    const p = paint(page)
    images.push(await encode(p.width, p.height, p.pixels, palette(o.theme)))
  }
  const omitted = pages
    .slice(MAX_IMAGES)
    .flat()
    .filter((r) => !r.cont).length
  return { images, omitted }
}

/** The patch of every file that is not hidden, with secret shapes masked, cut at 20 MB. */
export function buildPatch(
  files: DiffFile[],
  o: DiffOptions,
  limit = MAX_PATCH_BYTES,
): string {
  const re = matchers(o.exclude)
  const text = files
    .filter((f) => !hidden(f.file, re))
    .map((f) => filterSecrets(f.patch).replace(/\s+$/, ""))
    .filter(Boolean)
    .join("\n")
  if (Buffer.byteLength(text) <= limit) return text
  return (
    Buffer.from(text).subarray(0, limit).toString("utf8") +
    "\n[cut: the patch is longer than 20 MB]\n"
  )
}

/** The files by name, and which are hidden. */
export function fileList(files: DiffFile[], o: DiffOptions): string[] {
  const re = matchers(o.exclude)
  return files.map((f) => {
    const name = o.name ? o.name(f.file) : f.file
    return hidden(f.file, re) ? `${name} (content hidden)` : name
  })
}

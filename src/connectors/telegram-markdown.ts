/**
 * Markdown to Telegram HTML for what an assistant writes: fenced and inline
 * code, bold, italic, strikethrough, links, headings, lists and quotes.
 * Everything else is plain text, and all text is escaped first, so nothing the
 * model writes can become markup. A line whose tags do not balance falls back
 * to plain escaped text.
 */
import { esc } from "./telegram-render.ts"

export const LIMIT = 4096

const LANG = /^[\w+#.-]{1,20}$/
const SAFE_URL = /^(https?:\/\/|mailto:|tg:\/\/)[^\s"'<>()]+$/i

const balanced = (html: string): boolean => {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)([a-z]+)(?:\s[^>]*)?>/g)) {
    if (m[1]) {
      if (stack.pop() !== m[2]) return false
    } else stack.push(m[2])
  }
  return stack.length === 0
}

/** One line of inline markdown. */
export function inline(line: string): string {
  const codes: string[] = []
  const held = line.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\uE000${codes.length - 1}\uE000`
  })
  let t = esc(held)
  t = t.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (all, text: string, url: string) => {
      // The url has been escaped as text: undo it for the check, keep it escaped for the attribute.
      const raw = url.replace(/&amp;/g, "&")
      return SAFE_URL.test(raw) ? `<a href="${url}">${text}</a>` : all
    },
  )
  t = t
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/(?<![\w_])__(?=\S)([^\n]+?)(?<=\S)__(?![\w_])/g, "<b>$1</b>")
    .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, "<s>$1</s>")
    .replace(
      /(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g,
      "<i>$1</i>",
    )
    .replace(/(?<![\w_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\w_])/g, "<i>$1</i>")
  t = t.replace(/\uE000(\d+)\uE000/g, (_, i: string) => codes[Number(i)])
  return balanced(t) ? t : esc(line)
}

function textBlock(lines: string[]): string {
  const out: string[] = []
  let quote: string[] = []
  const flush = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`)
    quote = []
  }
  for (const line of lines) {
    const q = /^>\s?(.*)$/.exec(line)
    if (q) {
      quote.push(inline(q[1]))
      continue
    }
    flush()
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
    if (h) {
      const body = inline(h[1])
      out.push(/<b>/.test(body) ? body : `<b>${body}</b>`)
      continue
    }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (li) {
      out.push(`${li[1]}• ${inline(li[2])}`)
      continue
    }
    out.push(inline(line))
  }
  flush()
  return out.join("\n")
}

const fence = /^```\s*([^\s`]*)\s*$/

type Block = {
  code: boolean
  lang: string
  lines: string[]
  /** A GFM table: the header row, the separator, then the rows. */
  table?: boolean
}

/** Widest a table can be, in monospace characters, to stay a `<pre>` grid. */
export const NARROW = 40

/** The cells of a table row; a pipe in a code span or after a backslash belongs to the cell. */
function cells(row: string): string[] {
  const out: string[] = []
  let cur = ""
  let code = false
  const s = row.trim().replace(/^\|/, "")
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|"
      i++
    } else if (c === "`") {
      code = !code
      cur += c
    } else if (c === "|" && !code) {
      out.push(cur.trim())
      cur = ""
    } else cur += c
  }
  // A trailing pipe closes the last cell; without one the last cell is still open.
  if (cur.trim() || !/\|\s*$/.test(row)) out.push(cur.trim())
  return out
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** Whether `head` and `sep` start a GFM table. */
const startsTable = (head: string, sep: string): boolean =>
  head.includes("|") &&
  sep.includes("|") &&
  SEPARATOR.test(sep) &&
  cells(head).length === cells(sep).length

/** Cuts the tables out of a run of text lines. */
function carve(lines: string[]): Block[] {
  const out: Block[] = []
  let text: string[] = []
  const flush = () => {
    if (text.length) out.push({ code: false, lang: "", lines: text })
    text = []
  }
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 < lines.length && startsTable(lines[i], lines[i + 1])) {
      flush()
      let j = i + 2
      while (j < lines.length && lines[j].trim() && lines[j].includes("|")) j++
      out.push({ code: false, lang: "", lines: lines.slice(i, j), table: true })
      i = j - 1
    } else text.push(lines[i])
  }
  flush()
  return out
}

/** A cell without its markdown, for the monospace grid. */
const plain = (s: string): string =>
  s
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, "$1")
    .replace(/(?<![\w_])__(?=\S)([^\n]+?)(?<=\S)__(?![\w_])/g, "$1")
    .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, "$1")
    .replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\w_])/g, "$1")

const width = (s: string) => [...s].length

function pad(s: string, w: number, align: string): string {
  const gap = " ".repeat(Math.max(0, w - width(s)))
  if (align === "r") return gap + s
  if (align === "c") {
    const left = Math.floor(gap.length / 2)
    return gap.slice(0, left) + s + gap.slice(left)
  }
  return s + gap
}

/** A table as a monospace grid when it is narrow, and as one block per row when it is not. */
function renderTable(lines: string[]): string {
  const head = cells(lines[0])
  const n = head.length
  const aligns = cells(lines[1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "c" : c.endsWith(":") ? "r" : "l",
  )
  const rows = lines
    .slice(2)
    .map((l) => Array.from({ length: n }, (_, i) => cells(l)[i] ?? ""))
  const grid = [head, ...rows].map((r) => r.map(plain))
  const widths = head.map((_, i) => Math.max(...grid.map((r) => width(r[i]))))
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (n - 1)
  if (total <= NARROW) {
    const line = (r: string[]) =>
      r
        .map((c, i) => pad(c, widths[i], aligns[i]))
        .join("  ")
        .trimEnd()
    const rule = widths.map((w) => "─".repeat(w)).join("  ")
    return `<pre>${esc([line(grid[0]), rule, ...grid.slice(1).map(line)].join("\n"))}</pre>`
  }
  return rows
    .map((r) => {
      const first = inline(r[0])
      return [
        /<b>/.test(first) ? first : `<b>${first}</b>`,
        ...r
          .slice(1)
          .map((c, i) => (c ? `${inline(head[i + 1])}: ${inline(c)}` : ""))
          .filter(Boolean),
      ].join("\n")
    })
    .join("\n\n")
}

/** Splits markdown into fenced code blocks and runs of text lines. */
function blocks(md: string): Block[] {
  const out: Block[] = []
  let cur: Block | undefined
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    const f = fence.exec(line)
    if (cur?.code) {
      if (f && !f[1]) {
        out.push(cur)
        cur = undefined
      } else cur.lines.push(line)
    } else if (f) {
      if (cur) out.push(cur)
      cur = { code: true, lang: f[1], lines: [] }
    } else {
      if (!cur) cur = { code: false, lang: "", lines: [] }
      cur.lines.push(line)
    }
  }
  // An unclosed fence (a reply still streaming) is shown as code too.
  if (cur) out.push(cur)
  return out.flatMap((b) => (b.code ? [b] : carve(b.lines)))
}

const renderBlock = (b: Block): string => {
  if (b.table) return renderTable(b.lines)
  if (b.code) {
    const body = esc(b.lines.join("\n"))
    return LANG.test(b.lang)
      ? `<pre><code class="language-${b.lang}">${body}</code></pre>`
      : `<pre>${body}</pre>`
  }
  // Blank lines at the ends only add gaps between blocks.
  let from = 0
  let to = b.lines.length
  while (from < to && !b.lines[from].trim()) from++
  while (to > from && !b.lines[to - 1].trim()) to--
  return textBlock(b.lines.slice(from, to))
}

/** The whole markdown as HTML. */
export function markdownToHtml(md: string): string {
  return blocks(md)
    .map(renderBlock)
    .filter((h) => h.trim())
    .join("\n")
    .trim()
}

/** The markdown with any code fence left open closed, for a render of a reply still being written. */
export function closeFences(md: string): string {
  let open = false
  for (const line of md.split("\n")) {
    const f = fence.exec(line)
    if (f && (open ? !f[1] : true)) open = !open
  }
  return open ? `${md}\n\`\`\`` : md
}

/** Pieces of markdown, each of which renders to at most `limit` characters. */
function pieces(md: string, limit: number): string[] {
  const out: string[] = []
  const fits = (s: string) => markdownToHtml(s).length <= limit
  const cut = (s: string, wrap: (t: string) => string) => {
    // Lines first; a line longer than the limit is cut by characters.
    let cur: string[] = []
    const emit = () => {
      if (cur.length) out.push(wrap(cur.join("\n")))
      cur = []
    }
    const add = (line: string) => {
      if (fits(wrap([...cur, line].join("\n")))) return void cur.push(line)
      emit()
      if (fits(wrap(line))) return void cur.push(line)
      let n = line.length
      while (n > 1 && !fits(wrap(line.slice(0, n)))) n = Math.floor(n * 0.8)
      cur.push(line.slice(0, n))
      emit()
      add(line.slice(n))
    }
    for (const line of s.split("\n")) add(line)
    emit()
  }
  for (const b of blocks(md)) {
    const text = b.lines.join("\n")
    const whole = b.code ? `\`\`\`${b.lang}\n${text}\n\`\`\`` : text
    if (!whole.trim()) continue
    if (fits(whole)) out.push(whole)
    else if (b.table) {
      // Between rows, each piece with the header again.
      const [head, sep, ...rows] = b.lines
      let cur: string[] = []
      for (const row of rows) {
        const next = [head, sep, ...cur, row].join("\n")
        if (cur.length && !fits(next)) {
          out.push([head, sep, ...cur].join("\n"))
          cur = []
        }
        cur.push(row)
      }
      if (cur.length) out.push([head, sep, ...cur].join("\n"))
    } else if (b.code) cut(text, (t) => `\`\`\`${b.lang}\n${t}\n\`\`\``)
    else {
      // Paragraphs, then lines.
      for (const para of text.split(/\n{2,}/))
        if (fits(para)) out.push(para)
        else cut(para, (t) => t)
    }
  }
  return out
}

export type Split = { messages: string[]; rest?: string }

/**
 * A reply as at most `max` messages of HTML, split between blocks where it can.
 * What does not fit in them comes back as `rest`, in markdown.
 */
export function splitReply(md: string, max = 3, limit = LIMIT - 96): Split {
  const chunks: string[] = []
  let cur: string[] = []
  const list = pieces(md, limit)
  let i = 0
  for (; i < list.length; i++) {
    const next = [...cur, list[i]].join("\n\n")
    if (cur.length && markdownToHtml(next).length > limit) {
      if (chunks.length === max - 1) break
      chunks.push(cur.join("\n\n"))
      cur = [list[i]]
    } else cur = [...cur, list[i]]
  }
  if (i < list.length) {
    chunks.push(cur.join("\n\n"))
    return {
      messages: chunks.map(markdownToHtml),
      rest: list.slice(i).join("\n\n"),
    }
  }
  if (cur.length) chunks.push(cur.join("\n\n"))
  return { messages: chunks.map(markdownToHtml) }
}

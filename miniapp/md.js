// Markdown for the chat bubbles: a small subset parsed into plain objects. The page builds the
// elements from them, so no text from a session is ever read as markup.

const FENCE = /^```([\w+-]*)\s*$/
const CLOSE = /^```\s*$/
const HEAD = /^(#{1,3})\s+(.*)$/
const UL = /^\s*[-*+]\s+(.*)$/
const OL = /^\s*\d+[.)]\s+(.*)$/
const ROW = /^\s*\|.*\|\s*$/
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const INLINE =
  /`([^`\n]{1,300})`|\*\*([^*\n]{1,300})\*\*|\*([^*\s][^*\n]{0,299}?)\*|\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g

/** Inline spans: code, bold, italic and http(s) links; the rest is text. */
export function inline(s) {
  const out = []
  let at = 0
  // Its own copy: a span inside a span calls this again, and a shared one would lose its place.
  const re = new RegExp(INLINE)
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ t: "text", v: s.slice(at, m.index) })
    if (m[1] !== undefined) out.push({ t: "ic", v: m[1] })
    else if (m[2] !== undefined) out.push({ t: "b", c: inline(m[2]) })
    else if (m[3] !== undefined) out.push({ t: "i", c: inline(m[3]) })
    else out.push({ t: "a", href: m[5], c: [{ t: "text", v: m[4] }] })
    at = re.lastIndex
  }
  if (at < s.length) out.push({ t: "text", v: s.slice(at) })
  return out
}

const cells = (row) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())

/** Blocks: paragraphs, headings, lists, tables and fenced code. */
export function parse(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
  const out = []
  const para = []
  const flush = () => {
    if (para.length > 0) out.push({ t: "p", c: inline(para.join("\n")) })
    para.length = 0
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let m = FENCE.exec(line)
    if (m) {
      flush()
      const code = []
      for (i++; i < lines.length && !CLOSE.test(lines[i]); i++)
        code.push(lines[i])
      i++
      out.push({ t: "pre", lang: m[1], v: code.join("\n") })
      continue
    }
    if (ROW.test(line) && i + 1 < lines.length && SEP.test(lines[i + 1])) {
      flush()
      const head = cells(line).map(inline)
      const rows = []
      for (i += 2; i < lines.length && ROW.test(lines[i]); i++)
        rows.push(cells(lines[i]).map(inline))
      out.push({ t: "table", head, rows })
      continue
    }
    if ((m = HEAD.exec(line))) {
      flush()
      out.push({ t: "h", level: m[1].length, c: inline(m[2]) })
      i++
      continue
    }
    const list = UL.test(line) ? UL : OL.test(line) ? OL : undefined
    if (list) {
      flush()
      const items = []
      for (; i < lines.length && (m = list.exec(lines[i])); i++)
        items.push(inline(m[1]))
      out.push({ t: list === UL ? "ul" : "ol", items })
      continue
    }
    if (line.trim() === "") flush()
    else para.push(line)
    i++
  }
  flush()
  return out
}

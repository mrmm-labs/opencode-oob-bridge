import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"

import {
  buildPatch,
  COLOUR_PAIRS,
  COLUMNS,
  DEFAULT_EXCLUDE,
  drawDiff,
  fileList,
  IMAGE_WIDTH,
  MAX_PATCH_BYTES,
  palette,
  ROWS_PER_IMAGE,
  type DiffFile,
  type DiffOptions,
} from "./diffimage.ts"
import { glyph, hasGlyph } from "./font.ts"
import { encodePng } from "./png.ts"
import { decodePng } from "./png.test-util.ts"

const O: DiffOptions = { exclude: DEFAULT_EXCLUDE, theme: "dark" }
const sha = (b: Uint8Array) => createHash("sha1").update(b).digest("hex")

const hunk = (lines: string[], at = 1) =>
  [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    `@@ -${at},${lines.length} +${at},${lines.length} @@`,
    ...lines,
  ].join("\n")

const file = (name: string, lines: string[], at = 1): DiffFile => ({
  file: name,
  status: "modified",
  additions: lines.filter((l) => l[0] === "+").length,
  deletions: lines.filter((l) => l[0] === "-").length,
  patch: hunk(lines, at),
})

const plain = file("src/a.ts", [" keep", "-old", "+new", "+more"], 10)
const long = file("src/long.ts", ["+" + "x".repeat(130)])
const many = (n: number) =>
  file(
    "src/big.ts",
    Array.from({ length: n }, (_, i) => `+line ${i}`),
  )

const GOLDEN = [
  ["c488c7eb1b67559d6dc2d0adb475463050eb1c71"],
  ["177b6b512ab818f615a07501a508ac6e3b621035"],
  ["1dc25c8051acc0b64c28c21ac61b016cefda39c9"],
]

const pixels = async (f: DiffFile[], o = O) => {
  const d = await drawDiff(f, o)
  return Promise.all(d.images.map((i) => decodePng(i)))
}
const rowsHigh = (h: number) => (h - 8) / 32

describe("diff image: the font", () => {
  it("draws every glyph of ASCII and Latin-1, and the set has not changed", () => {
    const h = createHash("sha1")
    let n = 0
    for (let c = 0x20; c <= 0xff; c++) {
      if (c > 0x7e && c < 0xa0) continue
      assert.ok(hasGlyph(c), "glyph " + c)
      assert.equal(glyph(c).length, 16)
      h.update(glyph(c))
      n++
    }
    assert.equal(n, 191)
    assert.equal(h.digest("hex"), "de3f42c70ddc500194fcc33e6e341f161f399d65")
  })

  it("draws a box for a character it does not have", () => {
    assert.ok(!hasGlyph(0x1f600))
    assert.deepEqual(glyph(0x1f600), glyph(0x01))
    assert.notDeepEqual(glyph(0x1f600), glyph(0x20))
  })
})

describe("diff image: the PNG encoder", () => {
  it("reads back the same pixels, palette and size", async () => {
    const w = 37
    const h = 11
    const px = Uint8Array.from({ length: w * h }, (_, i) => (i * 7) % 5)
    const pal: Array<[number, number, number]> = [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [9, 9, 9],
    ]
    const back = await decodePng(await encodePng(w, h, px, pal))
    assert.deepEqual([back.width, back.height], [w, h])
    assert.deepEqual(back.palette, pal)
    assert.deepEqual(back.pixels, px)
  })

  it("refuses a wrong pixel count", async () => {
    await assert.rejects(encodePng(2, 2, new Uint8Array(3), [[0, 0, 0]]))
  })
})

describe("diff image: layout", () => {
  it("is 900 px wide with 56 columns, and colours the rows by kind", async () => {
    assert.equal(COLUMNS, 56)
    assert.equal(IMAGE_WIDTH, 900)
    const [img] = await pixels([plain])
    assert.equal(img.width, 900)
    // file header, hunk header, keep, old, new, more
    assert.equal(rowsHigh(img.height), 6)
    const at = (row: number) => img.pixels[(4 + row * 32 + 1) * 900 + 899]
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(at), [3, 4, 0, 2, 1, 1])
  })

  it("wraps a 130 character line over three rows and cuts nothing", async () => {
    const [img] = await pixels([long])
    assert.equal(rowsHigh(img.height), 2 + 3)
    const same = await pixels([file("src/long.ts", ["+" + "x".repeat(51)])])
    assert.equal(rowsHigh(same[0].height), 2 + 1)
  })

  it("matches the golden images", async () => {
    const one = await pixels([plain])
    const wrapped = await pixels([long])
    const multi = await pixels([plain, long, many(3)])
    assert.deepEqual(
      [one, wrapped, multi].map((i) => i.map((x) => sha(x.pixels))),
      GOLDEN,
    )
  })

  it("draws the light theme with its own palette", async () => {
    const [a] = await pixels([plain])
    const [b] = await pixels([plain], { ...O, theme: "light" })
    assert.deepEqual(a.pixels, b.pixels)
    assert.notDeepEqual(a.palette, b.palette)
  })

  it("keeps a contrast ratio of at least 4.5 for every colour pair", () => {
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    for (const theme of ["dark", "light"] as const) {
      const p = palette(theme)
      for (const [t, bg] of COLOUR_PAIRS) {
        const [hi, lo] = [lum(p[t]), lum(p[bg])].sort((x, y) => y - x)
        const ratio = (hi + 0.05) / (lo + 0.05)
        assert.ok(ratio >= 4.5, `${theme} ${t}/${bg}: ${ratio.toFixed(2)}`)
      }
    }
  })
})

describe("diff image: limits", () => {
  it("holds a 500 line diff in three images, and the patch has every line", async () => {
    const f = many(500)
    const d = await drawDiff([f], O)
    assert.equal(d.images.length, 3)
    for (const i of d.images)
      assert.ok(rowsHigh((await decodePng(i)).height) <= ROWS_PER_IMAGE)
    assert.equal(d.omitted, 500 + 2 - 3 * ROWS_PER_IMAGE)
    const patch = buildPatch([f], O)
    assert.ok(patch.includes("+line 499"))
    assert.equal(
      patch.split("\n").filter((l) => l.startsWith("+line ")).length,
      500,
    )
  })

  it("keeps an image short enough for Telegram not to shrink it", async () => {
    const [img] = await pixels([many(200)])
    assert.ok(img.height <= 1280)
  })

  it("cuts a patch longer than the limit with a note", () => {
    const big: DiffFile = {
      file: "a",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n+" + "y".repeat(5000),
    }
    const p = buildPatch([big], O, 1000)
    assert.ok(Buffer.byteLength(p) < 1100)
    assert.match(p, /cut: the patch is longer than 20 MB/)
    assert.equal(MAX_PATCH_BYTES, 20 * 1024 * 1024)
  })
})

describe("diff image: what is not drawn", () => {
  const env = file(".env.local", ["+API=hunter2"])
  it("names a hidden file, draws none of it, and leaves it out of the patch", async () => {
    const [img] = await pixels([env])
    assert.equal(rowsHigh(img.height), 2)
    assert.equal(buildPatch([env, plain], O), plain.patch)
    assert.deepEqual(fileList([env, plain], O), [
      ".env.local (content hidden)",
      "src/a.ts",
    ])
  })

  it("matches the default globs at any depth", () => {
    for (const f of ["a/.env", "k.pem", "x/my_secret.json", "home/id_rsa"])
      assert.match(fileList([file(f, ["+x"])], O)[0], /content hidden/, f)
    assert.doesNotMatch(fileList([file("src/idea.ts", ["+x"])], O)[0], /hidden/)
  })

  it("masks a token in the image and the patch", async () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
    const a = file("t.ts", ["+k = " + token])
    const b = file("t.ts", ["+k = [redacted]"])
    assert.ok(!buildPatch([a], O).includes(token))
    assert.match(buildPatch([a], O), /\[redacted\]/)
    assert.deepEqual(
      (await pixels([a]))[0].pixels,
      (await pixels([b]))[0].pixels,
    )
  })

  it("shows a binary file as not shown", async () => {
    const bin: DiffFile = {
      file: "logo.png",
      status: "modified",
      additions: 0,
      deletions: 0,
      patch: "Binary files a/logo.png and b/logo.png differ",
    }
    const [img] = await pixels([bin])
    assert.equal(rowsHigh(img.height), 2)
  })

  it("draws a character outside Latin-1 as a box, and the patch keeps it", async () => {
    const e = file("e.ts", ["+a 😀 b"])
    const box = file("e.ts", ["+a \u0001 b"])
    assert.deepEqual(
      (await pixels([e]))[0].pixels,
      (await pixels([box]))[0].pixels,
    )
    assert.ok(buildPatch([e], O).includes("😀"))
  })

  it("applies the name function to every file name shown", () => {
    const o = { ...O, name: () => "(name hidden)" }
    assert.deepEqual(fileList([plain], o), ["(name hidden)"])
  })
})

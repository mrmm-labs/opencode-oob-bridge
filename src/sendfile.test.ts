import assert from "node:assert/strict"
import { mkdir, mkdtemp, open, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  fileTool,
  MAX_FILE_BYTES,
  MAX_PHOTO_BYTES,
  prepareFile,
} from "./sendfile.ts"

const sparse = async (path: string, size: number) => {
  const f = await open(path, "w")
  await f.truncate(size)
  await f.close()
}

async function area() {
  const root = await mkdtemp(join(tmpdir(), "oobb-file-"))
  const home = join(root, "home")
  const out = join(root, "elsewhere")
  await mkdir(home)
  await mkdir(out)
  await writeFile(join(home, "note.txt"), "hello")
  await writeFile(join(out, "secret.txt"), "nope")
  return { root, home, out }
}

describe("prepareFile", () => {
  it("picks photo for a small image and document for the rest under auto", async () => {
    const a = await area()
    await writeFile(join(a.home, "shot.PNG"), "x")
    await sparse(join(a.home, "big.png"), MAX_PHOTO_BYTES)
    const kinds = async (p: string, as?: string) => {
      const r = await prepareFile({ path: p, as, home: a.home })
      assert.ok(r.ok, JSON.stringify(r))
      return r.file.kind
    }
    assert.equal(await kinds(join(a.home, "shot.PNG")), "photo")
    assert.equal(await kinds(join(a.home, "big.png")), "document")
    assert.equal(await kinds(join(a.home, "note.txt")), "document")
    assert.equal(await kinds(join(a.home, "shot.PNG"), "document"), "document")
    assert.equal(await kinds(join(a.home, "shot.PNG"), "photo"), "photo")
  })

  it("refuses photo for a non-image or a big image, and an unknown 'as'", async () => {
    const a = await area()
    await sparse(join(a.home, "big.jpg"), MAX_PHOTO_BYTES + 1)
    for (const [p, as, why] of [
      ["note.txt", "photo", /only png, jpg and webp/],
      ["big.jpg", "photo", /under 10 MB/],
      ["note.txt", "video", /photo, document or auto/],
    ] as const) {
      const r = await prepareFile({ path: join(a.home, p), as, home: a.home })
      assert.ok(!r.ok && why.test(r.error), p + as)
    }
  })

  it("refuses a directory, a missing file, an empty path and a file over 50 MB", async () => {
    const a = await area()
    await sparse(join(a.home, "huge.bin"), MAX_FILE_BYTES + 1)
    const err = async (path: unknown) => {
      const r = await prepareFile({ path, home: a.home })
      assert.ok(!r.ok)
      return r.error
    }
    assert.match(await err(a.home), /directory/)
    assert.match(await err(join(a.home, "nope")), /not found/)
    assert.match(await err(""), /path is required/)
    assert.match(await err(undefined), /path is required/)
    assert.match(await err(join(a.home, "huge.bin")), /over the 50\.0 MB limit/)
  })

  it("allows a file of exactly 50 MB", async () => {
    const a = await area()
    await sparse(join(a.home, "edge.bin"), MAX_FILE_BYTES)
    assert.ok(
      (await prepareFile({ path: join(a.home, "edge.bin"), home: a.home })).ok,
    )
  })

  it("follows a symlink only when it stays inside the home directory", async () => {
    const a = await area()
    await symlink(join(a.home, "note.txt"), join(a.home, "inside.txt"))
    await symlink(join(a.out, "secret.txt"), join(a.home, "outside.txt"))
    await symlink(a.out, join(a.home, "outdir"))
    const ok = await prepareFile({
      path: join(a.home, "inside.txt"),
      home: a.home,
    })
    assert.ok(ok.ok)
    assert.equal(Buffer.from(await ok.file.read()).toString(), "hello")
    for (const p of ["outside.txt", "outdir"]) {
      const r = await prepareFile({ path: join(a.home, p), home: a.home })
      assert.ok(!r.ok && /outside your home/.test(r.error), p)
    }
  })

  it("resolves a relative path against the session directory and expands ~/", async () => {
    const a = await area()
    const rel = await prepareFile({
      path: "note.txt",
      cwd: a.home,
      home: a.home,
    })
    assert.ok(rel.ok && rel.file.name === "note.txt")
    const tilde = await prepareFile({ path: "~/note.txt", home: a.home })
    assert.ok(tilde.ok)
  })

  it("does not read the file until asked", async () => {
    const a = await area()
    const r = await prepareFile({
      path: join(a.home, "note.txt"),
      home: a.home,
    })
    assert.ok(r.ok)
    assert.equal(r.file.size, 5)
  })
})

describe("the oob_send_file tool", () => {
  it("is a tool named oob_send_file that needs only a path", () => {
    const t = fileTool(async () => ({ ok: true, message: "x" }))
    assert.equal(t.name, "oob_send_file")
    assert.deepEqual(t.input.required, ["path"])
    assert.deepEqual(Object.keys(t.input.properties).sort(), [
      "as",
      "caption",
      "path",
    ])
  })

  it("passes the calling session, answers with the message, and returns a failure as short text", async () => {
    const seen: Array<[string, unknown]> = []
    const t = fileTool(async (id, input) => {
      seen.push([id, input])
      return input.path === "bad"
        ? { ok: false, error: "no topic" }
        : { ok: true, message: "sent" }
    })
    assert.deepEqual(await t.execute({ path: "a" }, { sessionID: "ses_1" }), {
      content: "sent",
    })
    const bad = await t.execute({ path: "bad" }, { sessionID: "ses_2" })
    assert.equal(bad.content, "Error: no topic")
    assert.deepEqual(bad.metadata, { error: true })
    assert.deepEqual(
      seen.map((s) => s[0]),
      ["ses_1", "ses_2"],
    )
  })
})

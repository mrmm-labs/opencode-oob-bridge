import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { promisify } from "node:util"

const run = promisify(execFile)
const SCRIPT = new URL("../../scripts/hygiene.sh", import.meta.url).pathname
const HOST = "registry.fake-test.invalid"

const git = (dir: string, ...a: string[]) =>
  run("git", [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "-C",
    dir,
    ...a,
  ])

async function repo(files: Record<string, string>, denylist = HOST + "\n") {
  const dir = await mkdtemp(join(tmpdir(), "oobb-hygiene-"))
  await git(dir, "init", "-q")
  await mkdir(join(dir, ".github"))
  await writeFile(
    join(dir, ".github/hygiene-denylist.txt"),
    "# words\n" + denylist,
  )
  for (const [f, t] of Object.entries(files)) await writeFile(join(dir, f), t)
  await git(dir, "add", ".")
  await git(dir, "commit", "-q", "-m", "first")
  return dir
}

async function check(dir: string, env: Record<string, string> = {}) {
  try {
    const r = await run("bash", [SCRIPT], {
      cwd: dir,
      env: { ...process.env, HYGIENE_DENYLIST: "", HYGIENE_BASE: "", ...env },
    })
    return { code: 0, out: r.stdout + r.stderr }
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string }
    return { code: x.code, out: x.stdout + x.stderr }
  }
}

describe("hygiene check", () => {
  it("passes a clean repository", async () => {
    const r = await check(await repo({ "a.md": "nothing here\n" }))
    assert.equal(r.code, 0)
    assert.match(r.out, /clean/)
  })

  it("fails on a registry host literal and prints the file and line, never the host", async () => {
    const dir = await repo({
      "notes.md": "one\ntwo\npush to " + HOST + "/ns/img\n",
      "ok.md": "fine\n",
    })
    const r = await check(dir)
    assert.equal(r.code, 1)
    assert.match(r.out, /notes\.md:3/)
    assert.doesNotMatch(r.out, /ok\.md/)
    assert.ok(!r.out.includes(HOST), "the host is not printed")
    assert.ok(!r.out.includes("fake-test"), "no part of it is printed")
  })

  it("ignores case, and does not scan the deny-list itself", async () => {
    const dir = await repo({ "x.txt": "REGISTRY.FAKE-TEST.INVALID\n" })
    const r = await check(dir)
    assert.equal(r.code, 1)
    assert.match(r.out, /x\.txt:1/)
    assert.doesNotMatch(r.out, /hygiene-denylist/)
  })

  it("adds the words of the HYGIENE_DENYLIST secret, one per line, and does not print them", async () => {
    const dir = await repo({
      "a.md": "hello planted-word-xyz\nand other-secret-abc\n",
    })
    const r = await check(dir, {
      HYGIENE_DENYLIST: "planted-word-xyz\r\n\n  other-secret-abc  \n",
    })
    assert.equal(r.code, 1)
    assert.match(r.out, /a\.md:1/)
    assert.match(r.out, /a\.md:2/)
    assert.ok(
      !r.out.includes("planted-word-xyz") &&
        !r.out.includes("other-secret-abc"),
    )
  })

  it("checks the commit messages after HYGIENE_BASE, naming the commit and not the word", async () => {
    const dir = await repo({ "a.md": "fine\n" })
    const base = (await git(dir, "rev-parse", "HEAD")).stdout.trim()
    await writeFile(join(dir, "b.md"), "fine too\n")
    await git(dir, "add", "b.md")
    await git(dir, "commit", "-q", "-m", "deploy to " + HOST)
    const r = await check(dir, { HYGIENE_BASE: base })
    assert.equal(r.code, 1)
    assert.match(r.out, /message of commit [0-9a-f]+/)
    assert.ok(!r.out.includes(HOST))
    assert.equal(
      (await check(dir)).code,
      0,
      "without a base only files are read",
    )
  })

  it("fails when there is nothing to check against", async () => {
    const dir = await repo({ "a.md": "x\n" }, "")
    const r = await check(dir)
    assert.equal(r.code, 1)
    assert.match(r.out, /deny-list is empty/)
  })

  it("passes this repository", async () => {
    const root = new URL("../../", import.meta.url).pathname
    const r = await check(root)
    assert.equal(r.code, 0, r.out)
  })
})

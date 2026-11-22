import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  activeConfigPath,
  INSTALL_DIR,
  mismatches,
  readInstalled,
  chatLines,
  reportLines,
  span,
  RUNNING,
  type VersionReport,
} from "./version.ts"

const tmp = () => mkdtemp(join(tmpdir(), "oobb-version-"))
const git = (dir: string, ...a: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "-C",
      dir,
      ...a,
    ],
    { stdio: "pipe" },
  )

describe("mismatches", () => {
  it("is silent when everything agrees, or when nothing is known", () => {
    assert.deepEqual(
      mismatches({
        installed: ["0.23.0", "0.23.0"],
        server: "0.23.0",
        tuis: ["0.23.0"],
      }),
      [],
    )
    assert.deepEqual(mismatches({ installed: [], tuis: [] }), [])
    assert.deepEqual(
      mismatches({
        installed: [undefined, "unknown"],
        server: "unknown",
        tuis: [],
      }),
      [],
    )
  })

  it("asks for a restart when the disk is newer than the server", () => {
    assert.deepEqual(
      mismatches({ installed: ["0.23.0"], server: "0.22.0", tuis: ["0.23.0"] }),
      ["⚠ the server runs 0.22.0 but 0.23.0 is installed: restart OpenCode"],
    )
  })

  it("asks for a restart when a TUI is stale", () => {
    assert.deepEqual(
      mismatches({
        installed: ["0.23.0"],
        server: "0.23.0",
        tuis: ["0.22.0", "0.23.0"],
      }),
      ["⚠ a TUI runs 0.22.0 but 0.23.0 is installed: restart OpenCode"],
    )
  })

  it("names every stale part, and flags install directories that differ", () => {
    const out = mismatches({
      installed: ["0.23.0", "0.21.0"],
      server: "0.22.0",
      tuis: ["0.22.0"],
    })
    assert.equal(out.length, 3)
    assert.match(
      out[0],
      /install directories hold different versions \(0\.23\.0, 0\.21\.0\)/,
    )
    assert.match(out[1], /the server runs 0\.22\.0 but 0\.23\.0/)
    assert.match(out[2], /a TUI runs 0\.22\.0 but 0\.23\.0/)
  })

  it("compares the running halves with each other when the disk is unreadable", () => {
    const out = mismatches({
      installed: [undefined],
      server: "0.22.0",
      tuis: ["0.23.0"],
    })
    assert.equal(out.length, 1)
    assert.match(
      out[0],
      /^⚠ the server and the TUI run different versions \(the server 0\.22\.0, a TUI 0\.23\.0\): restart OpenCode$/,
    )
  })
})

describe("reportLines", () => {
  const report: VersionReport = {
    running: "0.22.0",
    installed: "0.23.0",
    describe: "v0.23.0-0-gabc1234",
    dir: "/opt/plugin",
    pid: 4242,
    startedAt: Date.UTC(2026, 10, 21, 8, 30, 0),
    ownerId: "ab12cd34",
    config: "/home/u/.config/opencode/oob-bridge.jsonc",
    core: { api: "v1", state: "listening", address: "127.0.0.1:7842" },
    tuis: ["0.23.0"],
    warnings: [
      "⚠ the server runs 0.22.0 but 0.23.0 is installed: restart OpenCode",
    ],
  }

  it("shows every field, and the server's warnings in a chat", () => {
    const text = reportLines(report).join("\n")
    assert.match(text, /Installed: 0\.23\.0 \(git v0\.23\.0-0-gabc1234\)/)
    assert.match(
      text,
      /Server runs: 0\.22\.0, pid 4242, started 2026-11-21 08:30:00 UTC/,
    )
    assert.match(text, /Owner instance: ab12cd34/)
    assert.match(text, /TUI runs: 0\.23\.0/)
    assert.match(text, /Config: \/home\/u\/.config\/opencode\/oob-bridge.jsonc/)
    assert.match(text, /Core API: v1, listening on 127\.0\.0\.1:7842/)
    assert.match(text, /⚠ the server runs 0\.22\.0 but 0\.23\.0 is installed/)
  })

  it("compares the asking TUI itself, and says all match when they do", () => {
    const stale = reportLines(report, { running: "0.21.0" }).join("\n")
    assert.match(stale, /TUI runs: 0\.21\.0/)
    assert.match(stale, /⚠ a TUI runs 0\.21\.0 but 0\.23\.0 is installed/)
    const ok = reportLines(
      { ...report, running: "0.23.0", warnings: [] },
      {
        running: "0.23.0",
        installed: { version: "0.23.0", dir: "/opt/plugin" },
      },
    ).join("\n")
    assert.match(ok, /All versions match\./)
    assert.doesNotMatch(ok, /⚠/)
  })

  it("shows the disk of the TUI when it is another directory", () => {
    const text = reportLines(
      { ...report, running: "0.23.0", warnings: [] },
      { running: "0.23.0", installed: { version: "0.20.0", dir: "/other" } },
    ).join("\n")
    assert.match(text, /Installed for this TUI: 0\.20\.0/)
    assert.match(text, /install directories hold different versions/)
  })
})

describe("what is loaded and what is on disk", () => {
  it("RUNNING is the version in package.json of the install directory", async () => {
    const p = JSON.parse(
      await readFile(join(INSTALL_DIR, "package.json"), "utf8"),
    )
    assert.equal(RUNNING, p.version)
  })

  it("reads the disk again each time, so an upgrade shows while RUNNING stays", async () => {
    const dir = await tmp()
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    )
    assert.equal((await readInstalled(dir)).version, "1.0.0")
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "1.1.0" }),
    )
    assert.equal((await readInstalled(dir)).version, "1.1.0")
    assert.notEqual(RUNNING, "1.1.0")
  })

  it("says unknown, never throws, for a missing or broken package.json", async () => {
    const dir = await tmp()
    assert.equal((await readInstalled(dir)).version, "unknown")
    await writeFile(join(dir, "package.json"), "{nope")
    assert.equal((await readInstalled(dir)).version, "unknown")
  })

  it("gives git describe for a checkout of its own", async () => {
    const dir = await tmp()
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    )
    git(dir, "init", "-q")
    git(dir, "add", "package.json")
    git(dir, "commit", "-q", "-m", "x")
    git(dir, "tag", "v1.0.0")
    assert.equal((await readInstalled(dir)).describe, "v1.0.0")
    await writeFile(join(dir, "dirty.txt"), "x")
    git(dir, "add", "dirty.txt")
    assert.equal((await readInstalled(dir)).describe, "v1.0.0-dirty")
  })

  it("does not describe a directory that only sits inside another repository", async () => {
    const outer = await tmp()
    git(outer, "init", "-q")
    const inner = join(outer, "plugins", "oob")
    await mkdir(inner, { recursive: true })
    await writeFile(
      join(inner, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    )
    const got = await readInstalled(inner)
    assert.equal(got.version, "1.0.0")
    assert.equal(got.describe, undefined)
  })

  it("finds the config file in use: the named one, the default, or the legacy name", async () => {
    const home = await tmp()
    const base = join(home, "opencode")
    await mkdir(base, { recursive: true })
    const env = { XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv
    assert.equal(await activeConfigPath(env), join(base, "oob-bridge.jsonc"))
    await writeFile(join(base, "ntfy-bridge.jsonc"), "{}")
    assert.equal(await activeConfigPath(env), join(base, "ntfy-bridge.jsonc"))
    await writeFile(join(base, "oob-bridge.jsonc"), "{}")
    assert.equal(await activeConfigPath(env), join(base, "oob-bridge.jsonc"))
    assert.equal(
      await activeConfigPath({
        ...env,
        OPENCODE_OOB_BRIDGE_CONFIG: "/x/y.jsonc",
      }),
      "/x/y.jsonc",
    )
  })
})

describe("the version in a chat", () => {
  const report: VersionReport = {
    running: "0.37.0",
    installed: "0.37.0",
    describe: "v0.37.0-0-gabc1234",
    dir: "/opt/plugin",
    pid: 4242,
    startedAt: Date.UTC(2026, 10, 22, 8, 30, 0),
    ownerId: "ab12cd34",
    config: "/home/u/.config/opencode/oob-bridge.jsonc",
    core: { api: "v1", state: "listening", address: "127.0.0.1:7842" },
    tuis: ["0.37.0", "0.37.0"],
    warnings: [],
  }
  const now = Date.UTC(2026, 10, 22, 11, 42, 0)

  it("says what runs, what is installed and for how long", () => {
    assert.deepEqual(chatLines(report, now), [
      "Running: 0.37.0",
      "Installed: 0.37.0 (git v0.37.0-0-gabc1234)",
      "TUI runs: 0.37.0",
      "Up: 3h 12m",
      "All versions match.",
    ])
  })

  it("holds no path, pid, instance id or address", () => {
    const text = chatLines(report, now).join("\n")
    for (const secret of [
      "/opt",
      "/home",
      "4242",
      "ab12cd34",
      "127.0.0.1",
      "7842",
    ])
      assert.ok(!text.includes(secret), secret)
  })

  it("carries the warnings, and says when no TUI is attached", () => {
    const text = chatLines(
      {
        ...report,
        tuis: [],
        warnings: [
          "⚠ the server runs 0.36.0 but 0.37.0 is installed: restart OpenCode",
        ],
      },
      now,
    ).join("\n")
    assert.match(text, /TUI runs: no TUI attached/)
    assert.match(text, /⚠ the server runs 0\.36\.0/)
    assert.doesNotMatch(text, /All versions match/)
  })
})

describe("span", () => {
  it("is the two largest units", () => {
    assert.equal(span(0), "0s")
    assert.equal(span(59_000), "59s")
    assert.equal(span(61_000), "1m")
    assert.equal(span(3_720_000), "1h 2m")
    assert.equal(span(90_000_000), "1d 1h")
    assert.equal(span(-5), "0s")
  })
})

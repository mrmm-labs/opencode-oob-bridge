import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { describe, it } from "node:test"
import { promisify } from "node:util"

const run = promisify(execFile)
const SCRIPT = new URL("../../scripts/relay-push.sh", import.meta.url).pathname
const FAKE = {
  RELAY_REGISTRY: "registry.fake-test.invalid/project",
  RELAY_REGISTRY_USER: "fake-test-user",
  RELAY_REGISTRY_TOKEN: "fake-test-token-0123456789",
  RELAY_IMAGE_PATH: "fake-test-team/oob-relay",
  RELAY_TAG: "v9.9.9",
}
const SECRETS = [
  "registry.fake-test.invalid",
  "fake-test-user",
  "fake-test-token-0123456789",
  "registry.fake-test.invalid/project/fake-test-team/oob-relay:v9.9.9",
  "fake-test-team/oob-relay",
]

async function push(env: Record<string, string>) {
  try {
    const r = await run("bash", [SCRIPT], {
      env: { PATH: process.env.PATH ?? "", ...env },
    })
    return { code: 0, out: r.stdout + r.stderr }
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string }
    return { code: x.code, out: x.stdout + x.stderr }
  }
}

/** What a log would show: the runner swallows the mask commands. */
const visible = (out: string) =>
  out
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n")

describe("the optional registry push", () => {
  it("does nothing, and says nothing about a registry, when a secret is missing", async () => {
    for (const drop of [
      "RELAY_REGISTRY",
      "RELAY_REGISTRY_USER",
      "RELAY_REGISTRY_TOKEN",
    ]) {
      const r = await push({ ...FAKE, [drop]: "", RELAY_PUSH_DRY_RUN: "1" })
      assert.equal(r.code, 0)
      assert.equal(r.out.trim(), "relay push: not configured, nothing pushed")
    }
  })

  it("masks the registry, the host, the user, the token and the reference before any other output", async () => {
    const r = await push({ ...FAKE, RELAY_PUSH_DRY_RUN: "1" })
    assert.equal(r.code, 0)
    const lines = r.out.split("\n").filter(Boolean)
    const firstOther = lines.findIndex((l) => !l.startsWith("::add-mask::"))
    const masks = lines
      .slice(0, firstOther)
      .map((l) => l.slice("::add-mask::".length))
    for (const s of SECRETS)
      assert.ok(masks.includes(s), "masked: " + s.slice(0, 8))
    assert.ok(
      lines.slice(firstOther).every((l) => !l.startsWith("::add-mask::")),
    )
  })

  it("filters every command's output, even a command that prints the reference", async () => {
    const r = await push({ ...FAKE, RELAY_PUSH_DRY_RUN: "1" })
    const shown = visible(r.out)
    assert.match(shown, /docker login \*\*\*/)
    assert.match(shown, /--tag \*\*\*/)
    for (const s of SECRETS)
      assert.ok(!shown.includes(s), "shown: " + s.slice(0, 8))
    assert.ok(!shown.includes("fake-test"), "no part of a secret is shown")
  })

  it("keeps the exit code of a failing command, still masked", async () => {
    const r = await push({
      ...FAKE,
      RELAY_PUSH_DRY_RUN: "1",
      RELAY_PUSH_DRY_RUN_FAIL: "1",
    })
    assert.notEqual(r.code, 0)
    for (const s of SECRETS) assert.ok(!visible(r.out).includes(s))
  })

  it("builds the reference from the registry, the optional path and the tag, with a plain default path", async () => {
    const dflt = await push({
      ...FAKE,
      RELAY_IMAGE_PATH: "",
      RELAY_PUSH_DRY_RUN: "1",
    })
    assert.ok(
      dflt.out.includes(
        "::add-mask::registry.fake-test.invalid/project/oob-relay:v9.9.9",
      ),
    )
    assert.ok(!dflt.out.includes("fake-test-team"))
    const own = await push({ ...FAKE, RELAY_PUSH_DRY_RUN: "1" })
    assert.ok(
      own.out.includes(
        "::add-mask::registry.fake-test.invalid/project/fake-test-team/oob-relay:v9.9.9",
      ),
    )
  })

  it("needs a release tag", async () => {
    const r = await push({ ...FAKE, RELAY_TAG: "", RELAY_PUSH_DRY_RUN: "1" })
    assert.equal(r.code, 1)
    assert.match(r.out, /no release tag/)
  })

  it("holds no set -x, and no action that renders a reference", async () => {
    const { readFile } = await import("node:fs/promises")
    const dir = new URL("../../", import.meta.url)
    const script = await readFile(new URL("scripts/relay-push.sh", dir), "utf8")
    assert.doesNotMatch(script, /set -[a-z]*x/)
    const wf = await readFile(
      new URL(".github/workflows/release.yml", dir),
      "utf8",
    )
    assert.doesNotMatch(
      wf,
      /docker\/build-push-action|docker\/metadata-action|set -x|GITHUB_STEP_SUMMARY/,
    )
    assert.match(wf, /DOCKER_BUILD_SUMMARY: "false"/)
    assert.match(wf, /DOCKER_BUILD_RECORD_UPLOAD: "false"/)
  })
})

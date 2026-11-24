// End to end against a real ntfy server. Uses NTFY_E2E_URL when set (CI starts
// the container), else starts binwiederhier/ntfy with docker, else skips.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { after, before, describe, it } from "node:test"
import { promisify } from "node:util"

import { Bridge, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import type { Answer } from "./inbound.ts"
import { Ntfy, NtfyConnector, type NtfyConfig } from "./connectors/ntfy.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

const run = promisify(execFile)
const IMAGE = "binwiederhier/ntfy"

let url = process.env.NTFY_E2E_URL ?? ""
let container = ""
let skip: string | false = false

async function healthy(base: string, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const res = await fetch(`${base}/v1/health`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`ntfy at ${base} not healthy`)
}

before(async () => {
  if (process.env.NTFY_E2E_SKIP) return void (skip = "NTFY_E2E_SKIP set")
  if (!url) {
    try {
      await run("docker", ["info"], { timeout: 10_000 })
    } catch {
      return void (skip = "docker not available")
    }
    const { stdout } = await run(
      "docker",
      ["run", "-d", "--rm", "-p", "127.0.0.1::80", IMAGE, "serve"],
      { timeout: 300_000 },
    )
    container = stdout.trim()
    const port = (await run("docker", ["port", container, "80/tcp"])).stdout
      .trim()
      .split("\n")[0]
      .split(":")
      .pop()
    url = `http://127.0.0.1:${port}`
  }
  await healthy(url)
})

after(async () => {
  if (container) await run("docker", ["rm", "-f", container]).catch(() => {})
})

type Msg = {
  id: string
  message: string
  title?: string
  sequence_id?: string
  actions?: Array<{ url: string; body: string; method: string }>
}

async function poll(topic: string): Promise<Msg[]> {
  const text = await (
    await fetch(`${url}/${topic}/json?poll=1&since=all`)
  ).text()
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Msg)
}

async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe("e2e against a real ntfy", () => {
  it("pushes a question, takes a button tap and a text reply, answers the form", async (t) => {
    if (skip) return t.skip(skip)
    const suffix = Math.random().toString(36).slice(2, 8)
    const cfg = parseConfig({
      server: url,
      topics: { out: `e2e-${suffix}-out`, in: `e2e-${suffix}-in` },
    }) as Config
    const replies: Array<{ formID: string; answer: Answer }> = []
    const host: Host = {
      session: async (id) => ({
        id,
        agent: "coordinator",
        directory: "/w/shop",
        title: "E2E",
      }),
      root: (id) => id,
      replyForm: async (_s, formID, answer) => {
        replies.push({ formID, answer })
      },
    }
    const router = new Router(cfg, async () => true)
    router.setAfk("on", Infinity)
    router.set("root", true)
    const nc = cfg.channels.ntfy.options as NtfyConfig
    const ntfy = new Ntfy({
      server: nc.server,
      topics: nc.topics,
      backoff: { min: 200, max: 1000 },
    })
    const bridge = new Bridge(
      cfg,
      host,
      [new NtfyConnector("ntfy", ntfy, nc)],
      new PendingStore(),
      router,
    )
    bridge.start()
    try {
      await new Promise((r) => setTimeout(r, 500))
      const fields = [
        {
          key: "q0",
          type: "string",
          description: "Ship it?",
          options: [{ label: "Yes" }, { label: "No" }],
          custom: true,
        },
      ]
      const asked = Date.now()
      await bridge.onEvent({
        type: "form.created",
        data: {
          form: {
            id: "frm_e2e1",
            sessionID: "root",
            metadata: { kind: "question" },
            fields,
          },
        },
      })
      const q = await waitFor(async () =>
        (await poll(nc.topics.out)).find((m) => m.actions?.length),
      )
      assert.ok(Date.now() - asked < 2000, "published within 2 s")
      assert.equal(q.title, "shop · coordinator asks")

      // What the phone does on a tap: the http action, verbatim.
      const tap = q.actions![0]
      await fetch(tap.url, { method: tap.method, body: tap.body })
      await waitFor(() => replies[0])
      assert.deepEqual(replies[0], {
        formID: "frm_e2e1",
        answer: { q0: "Yes" },
      })
      await waitFor(async () =>
        (await poll(nc.topics.out)).find(
          (m) => m.sequence_id === q.id && /Answered from ntfy/.test(m.message),
        ),
      )

      await bridge.onEvent({
        type: "form.created",
        data: {
          form: {
            id: "frm_e2e2",
            sessionID: "root",
            metadata: { kind: "question" },
            fields,
          },
        },
      })
      const q2 = await waitFor(async () =>
        (await poll(nc.topics.out)).find(
          (m) => m.id !== q.id && m.actions?.length,
        ),
      )
      const id = /#(\w{4})/.exec(q2.message)![1]
      await fetch(`${url}/${nc.topics.in}`, {
        method: "POST",
        body: `#${id} not yet`,
      })
      await waitFor(() => replies[1])
      assert.deepEqual(replies[1], {
        formID: "frm_e2e2",
        answer: { q0: "not yet" },
      })

      // A second answer to the same prompt is refused with a push.
      await fetch(`${url}/${nc.topics.in}`, {
        method: "POST",
        body: `#${id} 2`,
      })
      await waitFor(async () =>
        (await poll(nc.topics.out)).find((m) =>
          /already answered/.test(m.message),
        ),
      )
      assert.equal(replies.length, 2)
    } finally {
      await bridge.stop()
    }
  })
})

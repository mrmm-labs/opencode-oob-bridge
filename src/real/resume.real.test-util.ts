// Opt-in check against a real, isolated `opencode serve` (pnpm test:real). Not run in CI.
// It suspends a session with a waiting message, then taps Resume on the alert through the bridge.
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { Bridge, type Host } from "../bridge.ts"
import { parseConfig, type Config } from "../config.ts"
import { fakeTelegram } from "../connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "../connectors/telegram.ts"
import { PendingStore } from "../pending.ts"
import { Router } from "../routing.ts"
import { sleep } from "../util.ts"

const CHAT = 4242

let server: ChildProcess | undefined
let base = ""
let auth = ""
let dir = ""

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
    s.on("error", reject)
  })

async function api<T>(method: string, path: string, body?: unknown) {
  const res = await fetch(base + "/api" + path, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json()) as { data: T }
  if (!res.ok) throw new Error(method + " " + path + " " + res.status)
  return json.data
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "oobb-real-"))
  for (const d of ["data", "config", "state", "cache", "proj"])
    await mkdir(join(dir, d))
  const port = await freePort()
  server = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: join(dir, "proj"),
      env: {
        ...process.env,
        XDG_DATA_HOME: join(dir, "data"),
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_STATE_HOME: join(dir, "state"),
        XDG_CACHE_HOME: join(dir, "cache"),
      },
    },
  )
  base = `http://127.0.0.1:${port}`
  let out = ""
  const password = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("opencode serve did not start")),
      30_000,
    )
    server!.on("error", reject)
    server!.stdout!.on("data", (c) => {
      out += c
      const m = /server password (\S+)/.exec(out)
      if (m) {
        clearTimeout(t)
        resolve(m[1])
      }
    })
  })
  auth = "Basic " + Buffer.from("opencode:" + password).toString("base64")
})

after(() => void server?.kill())

describe("Resume against a real opencode serve", () => {
  it("wakes a suspended session and reports the outcome it observed", async () => {
    const session = await api<{ id: string }>("POST", "/session", {
      title: "real check",
      location: { directory: join(dir, "proj") },
    })
    await api("POST", `/session/${session.id}/synthetic`, {
      text: "waiting",
      resume: false,
    })
    const inbox = await api<unknown[]>("GET", `/session/${session.id}/inbox`)
    assert.equal(
      inbox.length,
      1,
      "a message waits and the session is suspended",
    )
    assert.deepEqual(await api("GET", "/session/active"), {})
    console.log("before: inbox", inbox.length, "active", {})

    // The host's synchronous views come from polling the real server.
    let running = false
    let waiting = inbox.length
    const poll = setInterval(() => {
      void (async () => {
        running =
          session.id in
          (await api<Record<string, unknown>>("GET", "/session/active"))
        waiting = (await api<unknown[]>("GET", `/session/${session.id}/inbox`))
          .length
      })().catch(() => {})
    }, 100)

    const tg = await fakeTelegram()
    tg.forum = true
    const channel = new TelegramConnector({
      token: async () => tg.token,
      chatId: String(CHAT),
      apiBase: tg.url,
      topicsFile: join(dir, "topics.json"),
      offsetFile: join(dir, "offset.json"),
      pollSeconds: 1,
      backoff: { min: 10, max: 40 },
    })
    const cfg = parseConfig({
      channels: { telegram: { token: { env: "X" } } },
    }) as Config
    const host: Host = {
      session: async (id) => ({
        id,
        agent: "build",
        directory: join(dir, "proj"),
        title: "real check",
      }),
      root: (id) => id,
      replyForm: async () => {},
      prompt: async () => {},
      busy: () => running,
      resume: async (id) => {
        await api("POST", `/session/${id}/synthetic`, {
          text: "Resumed from the chat",
          resume: true,
        })
      },
    }
    const router = new Router(cfg, async () => true)
    router.set(session.id, true)
    const bridge = new Bridge(cfg, host, [channel], new PendingStore(), router)
    bridge.onWaiting(() => waiting)
    bridge.start()

    await bridge.stalled(session.id, { pending: 1, minutes: 1 })
    await tg.waitFor(() =>
      tg.of("sendMessage").find((c) => /Resume wakes it/.test(c.body.text)),
    )
    tg.callback(CHAT, 701, "ctl:resume", 9001)
    const done = await tg.waitFor(
      () =>
        tg
          .of("editMessageText")
          .find((c) => /Resumed|nothing changed/.test(c.body.text)),
      40_000,
    )
    clearInterval(poll)
    console.log("alert now:", done.body.text)
    console.log("after: inbox", waiting, "running", running)
    assert.match(done.body.text, /working again/, "outcome working")
    await sleep(50)
    await bridge.stop()
    await tg.close()
  })
})

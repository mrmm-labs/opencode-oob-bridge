import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, it } from "node:test"
import { WebSocketServer, type WebSocket } from "ws"

import { LinkClient } from "./client.ts"
import { startLink } from "./start.ts"
import { seal, Verifier, type Down, type Up } from "./frame.ts"
import type { Handler } from "./serve.ts"

const SECRET = "c".repeat(48)

/** A relay as far as the bridge can tell: it checks the upgrade and the up frames and keeps them. */
async function relay(o: { port?: number } = {}) {
  const verify = new Verifier(SECRET, "up")
  const wss = new WebSocketServer({ noServer: true })
  const conns: WebSocket[] = []
  const frames: Up[] = []
  const refused: string[] = []
  const headers: Array<Record<string, string | string[] | undefined>> = []
  let attempts = 0
  const server = createServer()
  server.on("upgrade", (req, socket, head) => {
    attempts++
    headers.push(req.headers)
    const r = verify.openUpgrade(req.headers)
    if (!r.ok) {
      refused.push(r.reason)
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      conns.push(ws)
      ws.on("message", (d) => {
        const f = new Verifier(SECRET, "up", Date.now).open<Up>(d.toString())
        if (f.ok) frames.push(f.payload)
      })
    })
  })
  await new Promise<void>((ok) => server.listen(o.port ?? 0, "127.0.0.1", ok))
  const port = (server.address() as AddressInfo).port
  const sendDown = (f: Down, ws = conns.at(-1)!) =>
    ws.send(seal(SECRET, "down", f))
  return {
    url: "ws://127.0.0.1:" + port + "/link",
    port,
    conns,
    frames,
    refused,
    headers,
    attempts: () => attempts,
    sendDown,
    sendRaw: (t: string) => conns.at(-1)!.send(t),
    async waitFor<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
      const end = Date.now() + ms
      for (;;) {
        const v = fn()
        if (v) return v
        if (Date.now() > end) throw new Error("timed out")
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    async close() {
      for (const c of conns) c.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

const ok: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end('{"ok":true}')
}
const fast = { minMs: 10, maxMs: 40 }
const client = (
  url: string,
  h: Handler = ok,
  secret: () => Promise<string | undefined> = async () => SECRET,
) => new LinkClient({ url, secret, handler: h, backoff: fast })

describe("the outbound link", () => {
  it("connects with a valid upgrade proof, answers a request frame and reports up", async () => {
    const r = await relay()
    const c = client(r.url)
    assert.equal(c.status().state, "off")
    c.start()
    await r.waitFor(() => r.conns[0])
    await r.waitFor(() => c.up())
    assert.equal(c.status().state, "up")
    r.sendDown({
      t: "req",
      id: "q1",
      method: "GET",
      path: "/v1/meta",
      headers: {},
      client: "203.0.113.1",
    })
    await r.waitFor(() => r.frames.find((f) => f.t === "end"))
    assert.deepEqual(
      r.frames.map((f) => f.t),
      ["res", "chunk", "end"],
    )
    assert.equal((r.frames[0] as { status: number }).status, 200)
    await c.stop()
    await r.close()
  })

  it("refuses a URL that is not on the tailnet and opens no connection", async () => {
    const r = await relay()
    const c = client("wss://relay.example.com/link")
    c.start()
    await new Promise((x) => setTimeout(x, 50))
    assert.equal(c.status().state, "refused")
    assert.match(
      c.status().reason ?? "",
      /loopback, a tailnet address or a \*\.ts\.net/,
    )
    assert.equal(r.attempts(), 0)
    await r.close()
  })

  it("sends the key header on the dial when link.key is set, and not otherwise", async () => {
    const KEY = "k".repeat(40)
    const r = await relay()
    const withKey = new LinkClient({
      url: r.url,
      secret: async () => SECRET,
      key: async () => KEY,
      handler: ok,
      backoff: fast,
    })
    withKey.start()
    await r.waitFor(() => withKey.up())
    assert.equal(r.headers[0]["x-oob-link-key"], KEY)
    await withKey.stop()
    const plain = client(r.url)
    plain.start()
    await r.waitFor(() => plain.up())
    assert.equal(r.headers.at(-1)!["x-oob-link-key"], undefined)
    await plain.stop()
    await r.close()
  })

  it("trims the newline a key command prints, so the header equals the relay's key", async () => {
    const KEY = "k".repeat(40)
    const r = await relay()
    const c = startLink({
      cfg: {
        link: {
          url: r.url,
          allowHosts: [],
          secret: { command: ["printf", SECRET + "\n"] },
          key: { command: ["printf", KEY + " \n\n"] },
        },
      } as never,
      core: { handle: ok } as never,
      edge: { refresh: async () => {}, edge: {} } as never,
    })!
    await r.waitFor(() => c.up())
    assert.equal(r.headers[0]["x-oob-link-key"], KEY)
    await c.stop()
    await r.close()
  })

  it("waits with 'no key' while the key cannot be read, and never logs it", async () => {
    const KEY = "k".repeat(40)
    const r = await relay()
    let key: string | undefined
    const c = new LinkClient({
      url: r.url,
      secret: async () => SECRET,
      key: async () => key,
      handler: ok,
      backoff: fast,
    })
    c.start()
    await r.waitFor(() => c.status().reason === "no key")
    assert.equal(r.attempts(), 0)
    key = KEY
    await r.waitFor(() => c.up())
    assert.ok(!JSON.stringify(c.status()).includes(KEY))
    await c.stop()
    await r.close()
  })

  it("dials a host listed in allowHosts over wss, and refuses it over ws", async () => {
    const dialed: string[] = []
    class Stub {
      readyState = 0
      onopen = null
      onmessage = null
      onclose = null
      onerror = null
      constructor(url: string) {
        dialed.push(url)
      }
      send() {}
      close() {}
    }
    const mk = (url: string) =>
      new LinkClient({
        url,
        allowHosts: ["oob-link.home.example.test"],
        secret: async () => SECRET,
        handler: ok,
        backoff: fast,
        socket: Stub as never,
      })
    const good = mk("wss://oob-link.home.example.test/link")
    good.start()
    await new Promise((x) => setTimeout(x, 50))
    assert.deepEqual(dialed, ["wss://oob-link.home.example.test/link"])
    assert.notEqual(good.status().state, "refused")
    await good.stop()
    const bad = mk("ws://oob-link.home.example.test/link")
    bad.start()
    assert.equal(bad.status().state, "refused")
    assert.match(bad.status().reason ?? "", /needs wss/)
    assert.equal(dialed.length, 1)
  })

  it("stays down with a reason while there is no secret, and connects when it appears", async () => {
    const r = await relay()
    let secret: string | undefined
    const c = client(r.url, ok, async () => secret)
    c.start()
    await r.waitFor(() => c.status().reason === "no secret")
    assert.equal(r.attempts(), 0)
    secret = SECRET
    await r.waitFor(() => c.up())
    await c.stop()
    await r.close()
  })

  it("reconnects when the relay closes the connection, and when it restarts", async () => {
    const r = await relay()
    const c = client(r.url)
    c.start()
    await r.waitFor(() => c.up())
    r.conns[0].close()
    await r.waitFor(() => r.conns.length === 2 && c.up())
    const port = r.port
    await r.close()
    await r.waitFor(() => c.status().state === "down", 3000)
    assert.match(c.status().reason ?? "", /connection/)
    const again = await relay({ port })
    await again.waitFor(() => c.up(), 5000)
    await c.stop()
    await again.close()
  })

  it("does not act on a replayed frame or on a frame it sent itself", async () => {
    const r = await relay()
    let runs = 0
    const c = client(r.url, (_q, res) => {
      runs++
      res.writeHead(204)
      res.end()
    })
    c.start()
    await r.waitFor(() => c.up())
    const text = seal(SECRET, "down", {
      t: "req",
      id: "q9",
      method: "GET",
      path: "/v1/meta",
      headers: {},
      client: "x",
    })
    r.sendRaw(text)
    r.sendRaw(text)
    r.sendRaw(
      seal(SECRET, "up", {
        t: "req",
        id: "q8",
        method: "GET",
        path: "/v1/meta",
        headers: {},
        client: "x",
      } as never),
    )
    r.sendRaw(
      seal("w".repeat(48), "down", {
        t: "req",
        id: "q7",
        method: "GET",
        path: "/v1/meta",
        headers: {},
        client: "x",
      }),
    )
    await new Promise((x) => setTimeout(x, 100))
    assert.equal(runs, 1)
    await c.stop()
    await r.close()
  })

  it("sends a beat frame and takes the ack with its number as the answer", async () => {
    const r = await relay()
    const c = client(r.url)
    c.start()
    await r.waitFor(() => c.up())
    const p = c.beat({ seq: 5 }, 1000)
    const f = await r.waitFor(() => r.frames.find((x) => x.t === "beat"))
    assert.equal((f as { beat: { seq: number } }).beat.seq, 5)
    r.sendDown({ t: "ack", seq: 5 })
    assert.equal(await p, true)
    await c.stop()
    await r.close()
  })

  it("counts a beat with no ack as unacknowledged, and reconnects after two", async () => {
    const r = await relay()
    const c = client(r.url)
    c.start()
    await r.waitFor(() => c.up())
    assert.equal(await c.beat({ seq: 1 }, 30), false)
    assert.equal(await c.beat({ seq: 2 }, 30), false)
    await r.waitFor(() => r.conns.length === 2)
    await c.stop()
    await r.close()
  })

  it("answers false for a beat while the link is down", async () => {
    const c = client("ws://127.0.0.1:1/link")
    assert.equal(await c.beat({ seq: 1 }, 10), false)
  })

  it("stops for good: no reconnect after stop", async () => {
    const r = await relay()
    const c = client(r.url)
    c.start()
    await r.waitFor(() => c.up())
    await c.stop()
    await new Promise((x) => setTimeout(x, 100))
    assert.equal(r.conns.length, 1)
    assert.equal(c.up(), false)
    await r.close()
  })

  it("stops a stream when the relay reports the phone left", async () => {
    const r = await relay()
    let closed = false
    const c = client(r.url, (rq, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(": ok\n\n")
      rq.on("close", () => (closed = true))
    })
    c.start()
    await r.waitFor(() => c.up())
    r.sendDown({
      t: "req",
      id: "s1",
      method: "GET",
      path: "/v1/events",
      headers: {},
      client: "x",
    })
    await r.waitFor(() => r.frames.find((f) => f.t === "chunk"))
    r.sendDown({ t: "close", id: "s1" })
    await r.waitFor(() => closed)
    await c.stop()
    await r.close()
  })
})

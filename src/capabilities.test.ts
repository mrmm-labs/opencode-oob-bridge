import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Bridge, type BridgeEvent } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { connectorTypes } from "./connectors/index.ts"
import type {
  Capabilities,
  Connector,
  Inbound,
  Outcome,
  Push,
} from "./connectors/types.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"

const all: Capabilities = {
  buttons: true,
  edit: true,
  multiselect: true,
  threads: true,
  pairing: true,
  inboundPrompt: false,
}

function fake(cap: Partial<Capabilities>) {
  const sent: Push[] = []
  const updates: Push[] = []
  const rec: { in?: (m: Inbound) => Promise<Outcome | undefined> } = {}
  const ch: Connector = {
    id: "x",
    type: "x",
    capabilities: { ...all, ...cap },
    enabled: true,
    start: (cb) => void (rec.in = cb),
    hint: () => "reply by number",
    send: async (p) => {
      sent.push(p)
      return `r${sent.length}`
    },
    update: async (_ref, p) => {
      updates.push(p)
      return true
    },
    status: () => ({}),
  }
  return { ch, sent, updates, rec }
}

function rig(ch: Connector) {
  const cfg = parseConfig({
    channels: {
      ntfy: { server: "https://n.example", topics: { out: "a", in: "b" } },
    },
  }) as Config
  const router = new Router(cfg, async () => true)
  router.setAfk("on", Infinity)
  router.set("root", true)
  const replies: unknown[] = []
  const bridge = new Bridge(
    cfg,
    {
      session: async () => ({
        id: "root",
        agent: "a",
        directory: "/w/p",
        title: "T",
      }),
      root: () => "root",
      replyForm: async (_s, _f, a) => void replies.push(a),
    },
    [ch],
    new PendingStore(),
    router,
  )
  bridge.start()
  const ask = (multiple = false) =>
    bridge.onEvent({
      type: "form.created",
      data: {
        form: {
          id: "f1",
          sessionID: "root",
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              type: multiple ? "multiselect" : "string",
              description: "Go?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
    } as BridgeEvent)
  return { bridge, ask, replies }
}

describe("capabilities", () => {
  it("passes buttons and the session thread only to connectors that can use them", async () => {
    const a = fake({})
    await rig(a.ch).ask()
    assert.ok(a.sent[0].prompt)
    assert.ok(a.sent[0].session)

    const b = fake({ buttons: false, threads: false })
    await rig(b.ch).ask()
    assert.equal(b.sent[0].prompt, undefined)
    assert.equal(b.sent[0].session, undefined)
    assert.match(b.sent[0].message, /reply by number/)
  })

  it("a multiple-choice question gets no buttons without multiselect", async () => {
    const a = fake({ multiselect: false })
    await rig(a.ch).ask(true)
    assert.equal(a.sent[0].prompt, undefined)
  })

  it("without edit, the outcome is a follow-up message", async () => {
    const f = fake({ edit: false })
    delete f.ch.update
    const r = rig(f.ch)
    await r.ask()
    await r.bridge.onEvent({
      type: "form.replied",
      data: { id: "f1", sessionID: "root" },
    })
    assert.equal(f.sent.length, 2)
    assert.match(f.sent[1].message, /Answered in the TUI/)
    assert.equal(f.updates.length, 0)
  })

  it("with edit, the outcome rewrites the message", async () => {
    const f = fake({})
    const r = rig(f.ch)
    await r.ask()
    await r.bridge.onEvent({
      type: "form.replied",
      data: { id: "f1", sessionID: "root" },
    })
    assert.equal(f.sent.length, 1)
    assert.equal(f.updates.length, 1)
  })

  it("a prompt for a session is recognised and not applied", async () => {
    const f = fake({ inboundPrompt: true })
    const r = rig(f.ch)
    const out = await f.rec.in!({
      kind: "prompt",
      id: "m1",
      time: 1,
      text: "run the tests",
      from: { connector: "x", chat: "c" },
    })
    assert.equal(out, undefined)
    assert.deepEqual(r.replies, [])
    assert.equal(f.sent.length, 0)
  })

  it("registers connector types by name, and only ntfy and telegram ship", () => {
    assert.deepEqual(Object.keys(connectorTypes).sort(), ["ntfy", "telegram"])
    assert.equal(connectorTypes.ntfy.create.length, 2)
  })

  it("capabilities: ntfy has no pairing, threads or inbound prompt; telegram has pairing and chat", () => {
    const env = {
      name: "n",
      dir: "/nonexistent",
      tel: undefined as never,
      settings: { get: () => ({}), set() {} },
    }
    const n = connectorTypes.ntfy.create(
      env,
      connectorTypes.ntfy.parse(
        { server: "https://n.example", topics: { out: "a", in: "b" } },
        "",
      ),
    ) as Connector
    assert.deepEqual(n.capabilities, {
      buttons: true,
      edit: true,
      multiselect: false,
      rich: false,
      threads: false,
      pairing: false,
      inboundPrompt: false,
    })
    assert.equal(n.pair, undefined)
    const t = connectorTypes.telegram.create(
      env,
      connectorTypes.telegram.parse({ token: { env: "X" } }, ""),
    ) as Connector
    assert.equal(t.capabilities.pairing, true)
    assert.equal(t.capabilities.inboundPrompt, true)
  })
})

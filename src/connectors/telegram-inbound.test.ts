import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { flushLog } from "../logger.ts"
import { sleep } from "../util.ts"
import { fakeTelegram } from "./fake-telegram.test-util.ts"
import { TelegramConnector, type TelegramOptions } from "./telegram.ts"
import type { Inbound, Outcome } from "./types.ts"

const CHAT = 4242

type Handler = (m: Inbound) => Promise<Outcome | undefined> | undefined

async function rig(over: Partial<TelegramOptions> = {}, handler?: Handler) {
  const tg = await fakeTelegram()
  const dir = await mkdtemp(join(tmpdir(), "oobb-in-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    offsetFile: join(dir, "offset.json"),
    inboxFile: join(dir, "inbox.jsonl"),
    backoff: { min: 10, max: 40 },
    pollSeconds: 1,
    reactGapMs: 5,
    ...over,
  })
  const got: Inbound[] = []
  const ac = new AbortController()
  channel.start(async (m) => {
    got.push(m)
    return handler?.(m)
  }, ac.signal)
  return {
    tg,
    dir,
    got,
    ac,
    async done() {
      ac.abort()
      await tg.close()
    },
  }
}

const lines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

async function withLog<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "oobb-inlog-"))
  const file = join(dir, "bridge.log")
  const prev = process.env.OPENCODE_OOB_BRIDGE_LOG
  process.env.OPENCODE_OOB_BRIDGE_LOG = file
  try {
    return await fn(file)
  } finally {
    await flushLog()
    if (prev === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
    else process.env.OPENCODE_OOB_BRIDGE_LOG = prev
  }
}

describe("TelegramConnector inbound journal", () => {
  it("a handler that never returns does not stop polling, and other topics are still heard", async () => {
    const r = await rig({}, (m) =>
      m.text === "stuck" ? new Promise(() => {}) : undefined,
    )
    r.tg.message(CHAT, "stuck", 501, 1)
    r.tg.message(CHAT, "free", 501, 2)
    await r.tg.waitFor(() => r.got.find((g) => g.text === "free"))
    const polls = r.tg.of("getUpdates").length
    r.tg.message(CHAT, "later", 501, 3)
    await r.tg.waitFor(() => r.got.find((g) => g.text === "later"))
    assert.ok(r.tg.of("getUpdates").length > polls)
    await r.done()
  })

  it("keeps the offset where it was when an update cannot be written down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-in-"))
    // A directory where the journal should be: every write fails.
    await mkdir(join(dir, "inbox.jsonl"))
    const r = await rig({ inboxFile: join(dir, "inbox.jsonl") })
    r.tg.message(CHAT, "kept", 501)
    await r.tg.waitFor(() =>
      r.tg.of("getUpdates").length > 3 ? true : undefined,
    )
    assert.equal(r.got.length, 0)
    const offsets = new Set(r.tg.of("getUpdates").map((c) => c.body.offset))
    assert.equal(offsets.size, 1, "never moved past the update")
    await r.done()
  })

  it("handles again what an earlier run wrote down and did not finish", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-in-"))
    const inbox = join(dir, "inbox.jsonl")
    const update = (id: number) => ({
      update_id: id,
      message: {
        message_id: id,
        date: 1,
        text: "from before " + id,
        chat: { id: CHAT },
        reply_to_message: { message_id: 501 },
      },
    })
    await writeFile(
      inbox,
      [{ add: update(7) }, { add: update(8) }, { done: 7 }]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    )
    const r = await rig({ inboxFile: inbox })
    await r.tg.waitFor(() => r.got[0])
    assert.deepEqual(
      r.got.map((g) => g.text),
      ["from before 8"],
    )
    await r.tg.waitFor(async () => undefined as never).catch(() => {})
    await sleep(50)
    assert.ok((await lines(inbox)).some((l) => l.done === 8))
    await r.done()
  })

  it("a failed delivery is said in the topic, kept, and delivered on the next try", async () => {
    let tries = 0
    const r = await rig({ retryMs: [20, 20] }, async () =>
      ++tries === 1
        ? { ok: false, retry: true, text: "the host is down" }
        : { ok: true, sent: true, text: "→ sent" },
    )
    r.tg.message(CHAT, "do it", 501, 5)
    const notice = await r.tg.waitFor(() =>
      r.tg
        .of("sendMessage")
        .find((c) => /Not delivered \(the host is down\)/.test(c.body.text)),
    )
    assert.equal(notice.body.message_thread_id, 5)
    await r.tg.waitFor(() => (r.got.length === 2 ? true : undefined))
    await r.tg.waitFor(() =>
      r.tg
        .of("setMessageReaction")
        .some((c) => c.body.reaction[0].emoji === "⚡")
        ? true
        : undefined,
    )
    await sleep(50)
    assert.equal((await lines(join(r.dir, "inbox.jsonl"))).at(-1)?.done, 101)
    await r.done()
  })

  it("gives up after the last try and says so", async () => {
    const r = await rig({ retryMs: [10] }, async () => ({
      ok: false,
      retry: true,
      text: "no route",
    }))
    r.tg.message(CHAT, "again", 501, 5)
    await r.tg.waitFor(() =>
      r.tg.of("sendMessage").find((c) => /after 2 tries/.test(c.body.text)),
    )
    assert.equal(r.got.length, 2)
    await r.done()
  })

  it("an update that takes too long is reported and does not hold up its topic", async () => {
    const r = await rig({ handleMs: 60 }, (m) =>
      m.text === "slow" ? new Promise(() => {}) : undefined,
    )
    r.tg.message(CHAT, "slow", 501, 4)
    r.tg.message(CHAT, "next", 501, 4)
    await r.tg.waitFor(() => r.got.find((g) => g.text === "next"))
    assert.ok(
      r.tg
        .of("sendMessage")
        .some((c) =>
          /Could not handle that message: timed out/.test(c.body.text),
        ),
    )
    await r.done()
  })

  it("says where to write when the topic has no session, in that topic", async () => {
    const r = await rig({}, async () => undefined)
    r.tg.message(CHAT, "anyone there", undefined, 9)
    const sent = await r.tg.waitFor(() =>
      r.tg.of("sendMessage").find((c) => /No session here/.test(c.body.text)),
    )
    assert.equal(sent.body.message_thread_id, 9)
    assert.equal(r.got.length, 0, "nothing reaches the core")
    await r.done()
  })

  it("logs every update with its outcome, delivered or not", async () => {
    await withLog(async (file) => {
      const r = await rig({}, async (m) =>
        m.text === "yes"
          ? {
              ok: true,
              sent: true,
              text: "→ sent",
              delivered: { how: "sent" as const },
            }
          : m.text === "no"
            ? { ok: false, text: "Chat is off for this session" }
            : undefined,
      )
      r.tg.message(CHAT, "yes", 501, 1)
      r.tg.message(CHAT, "no", 501, 1)
      r.tg.message(CHAT, "nothing", 501, 1)
      r.tg.message(CHAT, "plain text in a topic nobody owns", undefined, 9)
      r.tg.message(999, "stranger")
      await r.tg.waitFor(() => r.got[2])
      await sleep(100)
      await flushLog()
      const seen = (await lines(file))
        .filter((l) => l.event === "telegram_inbound")
        .sort((a, b) => Number(a.update_id) - Number(b.update_id))
      assert.deepEqual(
        seen.map((l) => [l.outcome, l.reason]),
        [
          ["delivered", "sent"],
          ["refused", "Chat is off for this session"],
          ["ignored", "the core had nothing to do with it"],
          ["ignored", "no session is bound to this topic"],
          ["rejected", "chat is not the paired one"],
        ],
      )
      assert.ok(seen.every((l) => typeof l.update_id === "number"))
      assert.ok(!JSON.stringify(seen).includes("stranger"), "never the text")
      await r.done()
    })
  })
})

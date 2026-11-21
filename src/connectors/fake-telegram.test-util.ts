// A tiny in-process stand-in for the Telegram Bot API, for unit tests.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"

export type Call = { method: string; token: string; body: any }

export async function fakeTelegram(token = "123456:TESTTOKEN") {
  const calls: Call[] = []
  const updates: Array<Record<string, unknown> & { update_id: number }> = []
  const failures: Array<{
    method: string
    status: number
    body: Record<string, unknown>
  }> = []
  let updateSeq = 100
  let messageSeq = 500
  let threadSeq = 9000
  let forum = false
  let chatTitle: string | undefined
  let stickers: Array<{ emoji: string; custom_emoji_id: string }> = [
    "🎯",
    "🛠",
    "🔥",
    "💡",
    "📚",
    "🧪",
    "🚀",
    "🧩",
    "🔔",
    "🌱",
    "🏁",
    "🧭",
  ].map((emoji, i) => ({ emoji, custom_emoji_id: `e${i}` }))
  let pollLimit = Infinity
  // Files a test put on the server, by file_id, and which were fetched.
  const files = new Map<string, Uint8Array>()
  const downloads: string[] = []
  const polls = new Set<() => void>()

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = ""
    req.on("data", (c) => (data += c))
    req.on("end", async () => {
      const dl = /^\/file\/bot([^/]+)\/files\/(.+)$/.exec(req.url ?? "")
      if (req.method === "GET" && dl) {
        downloads.push(dl[2])
        const bytes = files.get(dl[2])
        if (dl[1] !== token || !bytes) return void res.writeHead(404).end()
        res.writeHead(200, { "Content-Type": "application/octet-stream" })
        return void res.end(Buffer.from(bytes))
      }
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "")
      if (req.method !== "POST" || !m) return void res.writeHead(404).end()
      // A file upload is multipart: its fields and the file text are kept as they came.
      const multipart = /multipart/.test(req.headers["content-type"] ?? "")
      const body = multipart
        ? {
            multipart: true,
            fields: Object.fromEntries(
              [
                ...data.matchAll(
                  /name="([^"]+)"(?:; filename="[^"]*")?\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([\s\S]*?)\r\n--/g,
                ),
              ].map((m) => [m[1], m[2]]),
            ),
          }
        : data
          ? JSON.parse(data)
          : {}
      const call = { method: m[2], token: m[1], body }
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(json))
      }
      if (m[1] !== token)
        return send(401, { ok: false, description: "Unauthorized" })
      const fi = failures.findIndex((f) => f.method === m[2])
      if (fi >= 0) {
        const [f] = failures.splice(fi, 1)
        calls.push(call)
        return send(f.status, { ok: false, description: "injected", ...f.body })
      }
      if (m[2] === "getUpdates") {
        const offset: number = body.offset ?? 0
        const due = () => updates.filter((u) => u.update_id >= offset)
        if (due().length === 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(done, 150)
            polls.add(done)
            function done() {
              clearTimeout(t)
              polls.delete(done)
              r()
            }
          })
        }
        const out = due().slice(0, pollLimit)
        // The offset confirms everything before it.
        for (let i = updates.length - 1; i >= 0; i--)
          if (updates[i].update_id < offset) updates.splice(i, 1)
        calls.push(call)
        return send(200, { ok: true, result: out })
      }
      calls.push(call)
      if (m[2] === "sendMessage")
        return send(200, { ok: true, result: { message_id: ++messageSeq } })
      if (m[2] === "getFile") {
        const bytes = files.get(body.file_id)
        if (!bytes)
          return send(400, {
            ok: false,
            description: "Bad Request: wrong file_id",
          })
        return send(200, {
          ok: true,
          result: {
            file_id: body.file_id,
            file_path: `files/${body.file_id}`,
            file_size: bytes.length,
          },
        })
      }
      if (m[2] === "getChat")
        return send(200, {
          ok: true,
          result: { id: body.chat_id, is_forum: forum, title: chatTitle },
        })
      if (m[2] === "createForumTopic")
        return send(200, {
          ok: true,
          result: { message_thread_id: ++threadSeq, name: body.name },
        })
      if (m[2] === "getForumTopicIconStickers")
        return send(200, { ok: true, result: stickers })
      if (m[2] === "getMe")
        return send(200, { ok: true, result: { username: "oob_test_bot" } })
      send(200, { ok: true, result: true })
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  // A test that fails before its `close()` must not keep the process alive.
  server.unref()
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const wake = () => [...polls].forEach((f) => f())

  return {
    url,
    token,
    calls,
    /** The id the last message got, sent or received. */
    get lastMessageId() {
      return messageSeq
    },
    of: (method: string) => calls.filter((c) => c.method === method),
    set forum(v: boolean) {
      forum = v
    },
    set title(v: string | undefined) {
      chatTitle = v
    },
    set stickers(v: Array<{ emoji: string; custom_emoji_id: string }>) {
      stickers = v
    },
    /** Makes the next call of `method` fail with this status and body. */
    fail(method: string, status: number, body: Record<string, unknown> = {}) {
      failures.push({ method, status, body })
    },
    message(
      chat: number,
      text: string,
      replyTo?: number,
      thread?: number,
      chatExtra: Record<string, unknown> = {},
      sender?: number,
    ) {
      updates.push({
        update_id: ++updateSeq,
        message: {
          message_id: ++messageSeq,
          date: Math.floor(Date.now() / 1000),
          text,
          from: { id: sender ?? chat },
          chat: { id: chat, ...chatExtra },
          message_thread_id: thread,
          reply_to_message: replyTo ? { message_id: replyTo } : undefined,
        },
      })
      wake()
    },
    /** Puts a file on the server; `fileId` is what a message names. */
    file(fileId: string, bytes: Uint8Array | string) {
      files.set(
        fileId,
        typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      )
    },
    downloads,
    /** A message with media fields (`photo`, `document`, `voice`, ...) and an optional caption. */
    media(
      chat: number,
      fields: Record<string, unknown>,
      caption?: string,
      thread?: number,
      replyTo?: number,
    ) {
      updates.push({
        update_id: ++updateSeq,
        message: {
          message_id: ++messageSeq,
          date: Math.floor(Date.now() / 1000),
          caption,
          chat: { id: chat },
          message_thread_id: thread,
          reply_to_message: replyTo ? { message_id: replyTo } : undefined,
          ...fields,
        },
      })
      wake()
    },
    callback(
      chat: number,
      messageID: number,
      data: string,
      thread?: number,
      sender?: number,
    ) {
      updates.push({
        update_id: ++updateSeq,
        callback_query: {
          id: `cbq${updateSeq}`,
          data,
          from: { id: sender ?? chat },
          message: {
            message_id: messageID,
            message_thread_id: thread,
            chat: { id: chat },
          },
        },
      })
      wake()
    },
    async waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
      const end = Date.now() + ms
      for (;;) {
        const v = fn()
        if (v) return v
        if (Date.now() > end) throw new Error("timed out")
        await new Promise((r) => setTimeout(r, 10))
      }
    },
    close: () =>
      new Promise<void>((r) => {
        wake()
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

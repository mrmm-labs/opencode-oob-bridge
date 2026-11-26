/**
 * Keeps calls to one chat under Telegram's limits (about one a second, 20 a minute in a group):
 * calls over budget wait, and wait as little as they can by merging.
 */

/** A call refused because the person is present, or dropped from the queue when they came back. */
export class Muted extends Error {
  /** Set once the connector has counted it as suppressed. */
  counted = false
  constructor() {
    super("muted while present")
  }
}

/** Methods that show something in a chat: refused while present. */
export const VISIBLE =
  /^(send|edit|pin|unpin|delete|forward|copy|createForumTopic|setMessageReaction)/

const PACED =
  /^(sendChatAction|sendMessage|editMessageText|editMessageReplyMarkup|editMessageCaption|pinChatMessage|unpinChatMessage|deleteMessage|setMessageReaction|sendPhoto|sendDocument|sendMediaGroup|sendMessageDraft|editForumTopic|createForumTopic|closeForumTopic|reopenForumTopic)$/
/** The text of two merged messages stays well under Telegram's 4096. */
const MERGED_MAX = 3500

type Waiter = { resolve: (v: unknown) => void; reject: (e: unknown) => void }
type Item = {
  method: string
  body: Record<string, unknown>
  run: (body: Record<string, unknown>) => Promise<unknown>
  waiters: Waiter[]
}
type Lane = {
  queue: Item[]
  sent: number[]
  last: number
  blockedUntil: number
  running: boolean
}

export type Rate = { gapMs: number; perMinute: number }

const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify({ ...a, text: 0 }) === JSON.stringify({ ...b, text: 0 })

export class SendBudget {
  readonly stats = { coalesced: 0 }
  private readonly lanes = new Map<string, Lane>()
  private readonly rate: Rate
  private readonly now: () => number
  private readonly muted: () => boolean

  constructor(rate: Rate, now: () => number, muted: () => boolean) {
    this.rate = rate
    this.now = now
    this.muted = muted
  }

  /** Whether `method` goes through the budget at all. */
  static paced(method: string, body: unknown): boolean {
    return (
      PACED.test(method) &&
      (body as { chat_id?: unknown } | undefined)?.chat_id !== undefined
    )
  }

  /** Runs `run` now or when the chat's budget allows; merges it into a queued call when it can. */
  run<T>(
    method: string,
    body: Record<string, unknown>,
    run: (body: Record<string, unknown>) => Promise<unknown>,
  ): Promise<T> {
    const lane = this.lane(String(body.chat_id))
    if (method === "sendChatAction") {
      // A typing indicator is worth nothing late: sent when the chat is idle, dropped otherwise.
      if (lane.queue.length > 0 || lane.running || this.wait(lane) > 0) {
        this.stats.coalesced++
        return Promise.resolve(undefined as T)
      }
      return run(body) as Promise<T>
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = { resolve, reject } as Waiter
      const queued = this.merge(lane, method, body, run, waiter)
      if (!queued) lane.queue.push({ method, body, run, waiters: [waiter] })
      this.pump(lane)
    })
  }

  /** Holds every call to a chat for `seconds`: Telegram said to wait. */
  cool(chatId: unknown, seconds: number): void {
    const lane = this.lane(String(chatId))
    lane.blockedUntil = Math.max(lane.blockedUntil, this.now() + seconds * 1000)
  }

  /** Drops every queued call: their callers get a `Muted` error. */
  drop(): void {
    for (const lane of this.lanes.values())
      for (const item of lane.queue.splice(0))
        for (const w of item.waiters) w.reject(new Muted())
  }

  private merge(
    lane: Lane,
    method: string,
    body: Record<string, unknown>,
    run: Item["run"],
    waiter: Waiter,
  ): boolean {
    if (method === "editMessageText") {
      const at = lane.queue.find(
        (i) =>
          i.method === method &&
          i.body.message_id === body.message_id &&
          i.body.inline_message_id === body.inline_message_id,
      )
      if (!at) return false
      at.body = body
      at.run = run
      at.waiters.push(waiter)
      this.stats.coalesced++
      return true
    }
    if (method !== "sendMessage" || body.reply_markup !== undefined)
      return false
    const last = lane.queue[lane.queue.length - 1]
    if (
      !last ||
      last.method !== method ||
      !same(last.body, body) ||
      typeof last.body.text !== "string" ||
      typeof body.text !== "string" ||
      last.body.text.length + body.text.length > MERGED_MAX
    )
      return false
    last.body = { ...last.body, text: last.body.text + "\n\n" + body.text }
    last.waiters.push(waiter)
    this.stats.coalesced++
    return true
  }

  private lane(chat: string): Lane {
    let l = this.lanes.get(chat)
    if (!l)
      this.lanes.set(
        chat,
        (l = {
          queue: [],
          sent: [],
          last: -Infinity,
          blockedUntil: 0,
          running: false,
        }),
      )
    return l
  }

  /** Milliseconds until the chat may take another call. */
  private wait(lane: Lane): number {
    const now = this.now()
    while (lane.sent.length && lane.sent[0] <= now - 60_000) lane.sent.shift()
    return Math.max(
      0,
      lane.blockedUntil - now,
      lane.last + this.rate.gapMs - now,
      lane.sent.length >= this.rate.perMinute ? lane.sent[0] + 60_000 - now : 0,
    )
  }

  private pump(lane: Lane): void {
    if (lane.running) return
    lane.running = true
    void (async () => {
      try {
        while (lane.queue.length > 0) {
          const wait = this.wait(lane)
          if (wait > 0) {
            await new Promise((r) => setTimeout(r, wait).unref?.())
            continue
          }
          const item = lane.queue.shift()!
          if (this.muted()) {
            for (const w of item.waiters) w.reject(new Muted())
            continue
          }
          lane.last = this.now()
          lane.sent.push(lane.last)
          await item.run(item.body).then(
            (v) => item.waiters.forEach((w) => w.resolve(v)),
            (e) => item.waiters.forEach((w) => w.reject(e)),
          )
        }
      } finally {
        lane.running = false
      }
    })()
  }
}

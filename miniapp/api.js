// The core API as the app uses it. The only credential is the init data Telegram gave the page.

export class ApiError extends Error {
  /** @param {number} status 0 when the request never got an answer */
  constructor(status, message) {
    super(message)
    this.status = status
  }

  /** What the person should be told: not a server message, which says nothing the app can use. */
  get kind() {
    return (
      { 401: "expired", 403: "forbidden", 429: "limited", 503: "offline" }[
        this.status
      ] ?? (this.status === 0 ? "offline" : "error")
    )
  }
}

export class Api {
  constructor({
    initData,
    base = "",
    fetch = globalThis.fetch.bind(globalThis),
  }) {
    this.initData = initData
    this.base = base
    this.fetch = fetch
  }

  headers(extra = {}) {
    return { authorization: "tma " + this.initData, ...extra }
  }

  async request(method, path, body, accept) {
    let res
    try {
      res = await this.fetch(this.base + path, {
        method,
        headers: this.headers({
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(accept ? { accept } : {}),
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new ApiError(0, "no connection")
    }
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = text
    }
    // An action the core refused answers with `{ ok: false, text }`: that text is the answer.
    if (!res.ok && typeof data?.ok !== "boolean")
      throw new ApiError(res.status, data?.error ?? "request failed")
    return data
  }

  meta() {
    return this.request("GET", "/v1/meta")
  }
  status() {
    return this.request("GET", "/v1/status")
  }
  options() {
    return this.request("GET", "/v1/options")
  }
  digest() {
    return this.request("GET", "/v1/digest")
  }
  sessions(offset = 0) {
    return this.request("GET", "/v1/sessions?limit=50&offset=" + offset)
  }
  session(id) {
    return this.request("GET", "/v1/sessions/" + encodeURIComponent(id))
  }
  messages(id, before) {
    return this.request(
      "GET",
      "/v1/sessions/" +
        encodeURIComponent(id) +
        "/messages?limit=20" +
        (before === undefined ? "" : "&before=" + before),
    )
  }
  patch(id) {
    return this.request(
      "GET",
      "/v1/sessions/" + encodeURIComponent(id) + "/diff",
      undefined,
      "text/x-diff",
    )
  }
  /** One action; the result is `{ ok, text }` whether the core did it or refused. */
  action(id, name, body = {}) {
    return this.request(
      "POST",
      "/v1/sessions/" + encodeURIComponent(id) + "/actions/" + name,
      body,
    )
  }
  create(body) {
    return this.request("POST", "/v1/sessions", body)
  }
  endNight() {
    return this.request("POST", "/v1/overnight/end")
  }

  /** The event stream, read with fetch: an EventSource cannot send a header. */
  async *events(lastId, signal) {
    let res
    try {
      res = await this.fetch(this.base + "/v1/events", {
        headers: this.headers({
          accept: "text/event-stream",
          ...(lastId === undefined ? {} : { "last-event-id": String(lastId) }),
        }),
        signal,
      })
    } catch {
      throw new ApiError(0, "no connection")
    }
    if (!res.ok || !res.body) throw new ApiError(res.status, "stream refused")
    yield { type: "open" }
    const dec = new TextDecoder()
    let buf = ""
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let at
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at)
        buf = buf.slice(at + 2)
        const e = parseBlock(block)
        if (e) yield e
      }
    }
  }
}

/** One SSE block: a comment is a heartbeat, anything else an event. */
export function parseBlock(block) {
  const e = { type: "message", id: undefined, data: undefined }
  let any = false
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue
    any = true
    const k = line.slice(
      0,
      line.indexOf(":") < 0 ? line.length : line.indexOf(":"),
    )
    const v = line.slice(k.length + 1).replace(/^ /, "")
    if (k === "id") e.id = Number(v)
    else if (k === "event") e.type = v
    else if (k === "data") {
      try {
        e.data = JSON.parse(v)
      } catch {
        e.data = v
      }
    }
  }
  return any ? e : { type: "beat" }
}

export const SILENCE_MS = 70_000
export const BACKOFF = [1000, 2000, 5000, 10000, 30000]

/**
 * Keeps the stream open: reconnects with the last event id, backs off, and
 * treats silence (no event and no keep-alive) as a drop. `onState` gets
 * "live" or "down"; `onEvent` gets each event; `onGap` runs when a reconnect
 * may have missed events.
 */
export class Stream {
  constructor({
    api,
    onState,
    onEvent,
    onBeat = () => {},
    sleep,
    now = Date.now,
    silenceMs = SILENCE_MS,
  }) {
    this.api = api
    this.onState = onState
    this.onEvent = onEvent
    this.onBeat = onBeat
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = now
    this.silenceMs = silenceMs
    this.lastId = undefined
    this.stopped = false
    this.ac = undefined
  }

  start() {
    this.stopped = false
    void this.loop()
  }

  stop() {
    this.stopped = true
    this.ac?.abort()
  }

  async loop() {
    let tries = 0
    while (!this.stopped) {
      const ac = (this.ac = new AbortController())
      let watchdog
      const arm = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => ac.abort(), this.silenceMs)
      }
      try {
        arm()
        for await (const e of this.api.events(this.lastId, ac.signal)) {
          arm()
          if (e.type === "open") {
            tries = 0
            this.onState("live")
          } else if (e.type === "beat") this.onBeat()
          else {
            if (e.id !== undefined) this.lastId = e.id
            this.onEvent(e)
          }
        }
      } catch (err) {
        if (err?.kind === "expired" || err?.kind === "forbidden") {
          this.onState("down", err.kind)
          return
        }
      } finally {
        clearTimeout(watchdog)
      }
      if (this.stopped) return
      this.onState("down")
      await this.sleep(BACKOFF[Math.min(tries++, BACKOFF.length - 1)])
    }
  }
}

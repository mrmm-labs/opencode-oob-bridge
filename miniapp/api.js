// The core API as the app uses it. The only credential is the init data Telegram gave the page.

export class ApiError extends Error {
  /**
   * @param {number} status 0 when the request never got an answer
   * @param {string} [message]
   * @param {string} [reason] the code the bridge gave for a refusal
   */
  constructor(status, message, reason) {
    super(message)
    this.status = status
    this.reason = typeof reason === "string" ? reason : undefined
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
      throw new ApiError(
        res.status,
        data?.error ?? "request failed",
        data?.error,
      )
    return data
  }

  meta() {
    return this.request("GET", "/v1/meta")
  }
  prompt(id) {
    return this.request("GET", "/v1/prompts/" + encodeURIComponent(id))
  }
  approval(id) {
    return this.request("GET", "/v1/approvals/" + encodeURIComponent(id))
  }
  approvalProof(id, body) {
    return this.request(
      "POST",
      "/v1/approvals/" + encodeURIComponent(id) + "/proof",
      body,
    )
  }
  approvalDecision(id, body) {
    return this.request(
      "POST",
      "/v1/approvals/" + encodeURIComponent(id) + "/decision",
      body,
    )
  }
  enrol(body) {
    return this.request("POST", "/v1/approvals/enroll", body)
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

  /** One diagnostic line for the bridge's log; it never says anything about the person or the init data. */
  log(event, data) {
    return this.request("POST", "/v1/log", { event, data })
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
    if (!res.ok || !res.body) {
      const why = await res.json().catch(() => undefined)
      throw new ApiError(res.status, "stream refused", why?.error)
    }
    yield { type: "open", status: res.status }
    // A reader, not `for await`: older iOS WebViews have no async iteration on a body.
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let at
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, at)
          buf = buf.slice(at + 2)
          const e = parseBlock(block)
          if (e) yield e
        }
      }
    } finally {
      // Whatever ended the loop, the request ends with it: an open one would stay until the WebView dropped it.
      reader.cancel().catch(() => {})
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
export const FIRST_BYTE_MS = 20_000
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
    firstByteMs = FIRST_BYTE_MS,
    note = () => {},
  }) {
    this.api = api
    this.onState = onState
    this.onEvent = onEvent
    this.onBeat = onBeat
    this.note = note
    this.firstByteMs = firstByteMs
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
      const began = this.now()
      let watchdog
      let bytes = false
      const arm = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(
          () => ac.abort(),
          bytes ? this.silenceMs : this.firstByteMs,
        )
      }
      try {
        arm()
        for await (const e of this.api.events(this.lastId, ac.signal)) {
          if (e.type === "open") {
            this.note("stream_open", { status: e.status })
            continue
          }
          // Live is the first bytes, not the headers: a proxy may answer the headers and hold the rest.
          if (!bytes) {
            bytes = true
            tries = 0
            this.note("stream_live", { ms: this.now() - began })
            this.onState("live")
          }
          arm()
          if (e.type === "beat") this.onBeat()
          else {
            if (e.id !== undefined) this.lastId = e.id
            this.onEvent(e)
          }
        }
        this.note("stream_end", { ms: this.now() - began, bytes })
      } catch (err) {
        this.note("stream_error", {
          name: String(err?.name ?? "").slice(0, 40),
          message: String(err?.message ?? "").slice(0, 100),
          status: err?.status ?? 0,
          reason: err?.reason ?? "",
          bytes,
          ms: this.now() - began,
        })
        if (err?.kind === "expired" || err?.kind === "forbidden") {
          this.onState("down", err.kind, err.reason)
          return
        }
      } finally {
        clearTimeout(watchdog)
        // The attempt is over, however it ended: its request must not outlive it.
        ac.abort()
      }
      if (this.stopped) return
      this.onState("down")
      await this.sleep(BACKOFF[Math.min(tries++, BACKOFF.length - 1)])
    }
  }
}

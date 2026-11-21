/**
 * ntfy: a minimal client (JSON publish, reconnecting JSON-stream subscription)
 * and the connector on top of it, with http buttons out and the in topic back.
 */
import { filterSecrets } from "../filter.ts"
import { parseReply, type Question } from "../inbound.ts"
import { log } from "../logger.ts"
import type { Telemetry } from "../otel.ts"
import {
  lazyToken,
  parseTokenSource,
  TOKEN_ERROR,
  tokenWaitText,
  TokenUnavailable,
  type TokenFn,
  type TokenSource,
} from "../token.ts"
import { isObject, sleep, truncate, URL_RE } from "../util.ts"
import type {
  Capabilities,
  Connector,
  ConnectorStatus,
  ConnectorType,
  Inbound,
  OnInbound,
  Push,
  SendStats,
} from "./types.ts"

export type HttpAction = {
  action: "http"
  label: string
  url: string
  method: "POST"
  body: string
  headers?: Record<string, string>
  clear?: boolean
}

export type Publish = {
  title?: string
  message: string
  tags?: string[]
  priority?: 1 | 2 | 3 | 4 | 5
  actions?: HttpAction[]
  /** Updates the earlier notification with this id instead of adding one. */
  sequence_id?: string
}

export type Incoming = { id: string; time: number; message: string }

export type NtfyOptions = {
  server: string
  topics: { out: string; in: string }
  token?: TokenFn
  /** Puts the token in each http action, so buttons work on a server that denies anonymous writes. */
  actionAuth?: boolean
  fetch?: typeof fetch
  /** Reconnect delays in ms: first and cap. */
  backoff?: { min: number; max: number }
  timeoutMs?: number
  tel?: Telemetry
}

export class Ntfy {
  /** Subscription state and the last failure, for the status view. */
  connected: boolean | undefined
  lastError: string | undefined
  private readonly fetch: typeof fetch
  private readonly opts: NtfyOptions
  constructor(opts: NtfyOptions) {
    this.opts = opts
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  private async headers(json: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = json
      ? { "Content-Type": "application/json" }
      : {}
    let token: string | undefined
    try {
      token = await this.opts.token?.()
    } catch (err) {
      // A failed token command is logged once per retry step by the token itself.
      if (!(err instanceof TokenUnavailable))
        log("token_error", { message: (err as Error).message })
    }
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }

  /** The last failure, or that the token is being waited for. */
  error(): string | undefined {
    const at = this.opts.token?.retryAt?.()
    return at === undefined ? this.lastError : tokenWaitText(at)
  }

  /** Publishes to the out topic. Returns the message id; never throws. */
  async publish(p: Publish, stats?: SendStats): Promise<string | undefined> {
    const headers = await this.headers(true)
    const auth =
      this.opts.actionAuth && headers.Authorization
        ? { headers: { Authorization: headers.Authorization } }
        : {}
    const body = {
      ...p,
      topic: this.opts.topics.out,
      title: p.title === undefined ? undefined : filterSecrets(p.title),
      message: filterSecrets(p.message),
      actions: p.actions?.map((a) => ({
        ...a,
        label: filterSecrets(a.label),
        ...auth,
      })),
    }
    try {
      const res = await this.fetch(`${this.opts.server}/`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // A pooled socket the proxy has already dropped hangs until the
        // timeout; pushes are rare, so each one opens a fresh connection.
        keepalive: false,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      })
      if (stats) stats.httpStatus = res.status
      if (!res.ok) {
        this.lastError = `publish failed: HTTP ${res.status}`
        log("publish_failed", { status: res.status })
        await res.body?.cancel()
        return undefined
      }
      const out = (await res.json()) as { id?: string }
      return out.id
    } catch (err) {
      this.lastError = `publish failed: ${(err as Error).message}`
      log("publish_error", { message: (err as Error).message })
      return undefined
    }
  }

  /**
   * Streams messages of the in topic until `signal` aborts. Reconnects with
   * exponential backoff and resumes with `since=<last id>`.
   */
  async subscribe(
    onMessage: (m: Incoming) => void,
    signal: AbortSignal,
    since?: string,
  ): Promise<void> {
    const { min, max } = this.opts.backoff ?? { min: 1000, max: 60_000 }
    let delay = min
    let last = since
    while (!signal.aborted) {
      let why = "closed"
      try {
        const headers = await this.headers(false)
        const at = this.opts.token?.retryAt?.()
        if (at !== undefined) {
          // Not anonymously, and not again before the token is asked for again.
          this.connected = false
          await sleep(Math.max(0, at - Date.now()), signal)
          continue
        }
        const q = last ? `?since=${encodeURIComponent(last)}` : ""
        const res = await this.fetch(
          `${this.opts.server}/${this.opts.topics.in}/json${q}`,
          { headers, signal },
        )
        if (!res.ok || !res.body) {
          why = `http-${res.status}`
          this.connected = false
          this.lastError = `subscribe failed: HTTP ${res.status}`
          log("subscribe_failed", { status: res.status })
          await res.body?.cancel()
        } else {
          delay = min
          this.connected = true
          const decoder = new TextDecoder()
          let buf = ""
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buf += decoder.decode(chunk, { stream: true })
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line) continue
              let m: {
                event?: string
                id?: string
                time?: number
                message?: string
              }
              try {
                m = JSON.parse(line)
              } catch {
                continue
              }
              if (m.event !== "message" || typeof m.id !== "string") continue
              last = m.id
              try {
                onMessage({
                  id: m.id,
                  time: m.time ?? 0,
                  message: m.message ?? "",
                })
              } catch (err) {
                log("inbound_handler_error", {
                  message: (err as Error).message,
                })
              }
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return
        why = "error"
        this.connected = false
        this.lastError = `subscribe failed: ${(err as Error).message}`
        log("subscribe_error", { message: (err as Error).message })
      }
      if (signal.aborted) return
      this.opts.tel?.count("oob.reconnects", { "connector.type": "ntfy" })
      this.opts.tel
        ?.begin("oob.reconnect", {
          attrs: { "connector.type": "ntfy", reason: why },
        })
        .end({ delay_ms: delay })
      await sleep(delay, signal)
      delay = Math.min(max, delay * 2)
    }
  }
}

const MAX_BUTTONS = 3
const LABEL_MAX = 24
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/

const hasButtons = (qs: Question[]) =>
  qs.length === 1 &&
  !qs[0].multiple &&
  qs[0].options.length > 0 &&
  qs[0].options.length <= MAX_BUTTONS

export function replyHint(id: string, qs: Question[], inTopic: string): string {
  const to = `to topic ${inTopic}`
  if (qs.length !== 1) return `Post \`#${id} <answer 1> | <answer 2> …\` ${to}`
  if (qs[0].multiple) return `Post \`#${id} 1,3\` (numbers) ${to}`
  if (hasButtons(qs))
    return `Tap a button, or post \`#${id} <n or text>\` ${to}`
  return `Reply by number: post \`#${id} <n or text>\` ${to}`
}

/** One button per option, for a single question with few options. */
export function questionActions(
  server: string,
  inTopic: string,
  id: string,
  qs: Question[],
): HttpAction[] | undefined {
  if (!hasButtons(qs)) return undefined
  return qs[0].options.map((label, i) => ({
    action: "http",
    label: truncate(label, LABEL_MAX),
    url: `${server}/${inTopic}`,
    method: "POST",
    body: JSON.stringify({ id, choice: i + 1 }),
    // Kept on screen: the answer replaces it through sequence_id.
    clear: false,
  }))
}

export type NtfyConnectorOptions = {
  server: string
  topics: { out: string; in: string }
}

export class NtfyConnector implements Connector {
  readonly type = "ntfy"
  readonly capabilities: Capabilities = {
    buttons: true,
    edit: true,
    multiselect: false,
    rich: false,
    threads: false,
    pairing: false,
    inboundPrompt: false,
  }
  enabled = true

  readonly id: string
  private readonly ntfy: Ntfy
  private readonly opts: NtfyConnectorOptions
  private onInbound: OnInbound | undefined

  constructor(id: string, ntfy: Ntfy, opts: NtfyConnectorOptions) {
    this.id = id
    this.ntfy = ntfy
    this.opts = opts
  }

  start(onInbound: OnInbound, signal: AbortSignal, openSince?: number): void {
    this.onInbound = onInbound
    // After a restart, replay the in topic from the oldest unanswered prompt.
    const since =
      openSince === undefined ? undefined : String(Math.floor(openSince / 1000))
    void this.ntfy.subscribe((m) => void this.handle(m), signal, since)
  }

  /** Parses one message of the in topic and hands the reply on. */
  async handle(m: Incoming): Promise<void> {
    const reply = parseReply(m.message)
    if (!reply) return
    const base = {
      kind: "answer",
      id: m.id,
      time: m.time,
      from: { connector: this.id, chat: this.opts.topics.in },
    } as const
    const inbound: Inbound =
      "choice" in reply
        ? {
            ...base,
            pendingId: reply.id,
            choice: reply.choice,
            text: String(reply.choice),
          }
        : { ...base, pendingId: reply.id, text: reply.text }
    await this.onInbound?.(inbound)
  }

  hint(id: string, qs: Question[]): string {
    return replyHint(id, qs, this.opts.topics.in)
  }

  send(push: Push): Promise<string | undefined> {
    return this.ntfy.publish(
      {
        title: push.title,
        message: push.message,
        tags: push.tags,
        priority: push.silent ? 1 : push.priority,
        actions: push.prompt
          ? questionActions(
              this.opts.server,
              this.opts.topics.in,
              push.prompt.id,
              push.prompt.questions,
            )
          : undefined,
      },
      push.stats,
    )
  }

  async update(ref: string, push: Push): Promise<boolean> {
    const id = await this.ntfy.publish(
      {
        title: push.title,
        message: push.message,
        tags: push.tags,
        priority: push.silent ? 1 : push.priority,
        sequence_id: ref,
      },
      push.stats,
    )
    return id !== undefined
  }

  status(): ConnectorStatus {
    return { connected: this.ntfy.connected, lastError: this.ntfy.error() }
  }
}

export type NtfyConfig = {
  server: string
  token?: TokenSource
  topics: { out: string; in: string }
  actionAuth: boolean
}

export const ntfyType: ConnectorType<NtfyConfig> = {
  legacyKeys: ["server", "token", "topics", "actionAuth"],

  parse(raw, at) {
    const server = raw.server
    if (typeof server !== "string" || !URL_RE.test(server))
      return { error: `${at}server must be an http(s) URL` }

    let token: TokenSource | undefined
    if (raw.token !== undefined) {
      token = parseTokenSource(raw.token)
      if (!token) return { error: `${at}${TOKEN_ERROR}` }
    }

    const topics = raw.topics
    if (
      !isObject(topics) ||
      typeof topics.out !== "string" ||
      typeof topics.in !== "string" ||
      !TOPIC.test(topics.out) ||
      !TOPIC.test(topics.in) ||
      topics.out === topics.in
    )
      return {
        error: `${at}topics.out and topics.in must be two different topic names`,
      }

    const actionAuth = raw.actionAuth ?? true
    if (typeof actionAuth !== "boolean")
      return { error: `${at}actionAuth must be true or false` }

    return {
      server: server.replace(/\/+$/, ""),
      token,
      topics: { out: topics.out, in: topics.in },
      actionAuth,
    }
  },

  create(env, o) {
    return new NtfyConnector(
      env.name,
      new Ntfy({
        server: o.server,
        topics: o.topics,
        actionAuth: o.actionAuth,
        token: lazyToken(o.token),
        tel: env.tel,
      }),
      o,
    )
  },
}

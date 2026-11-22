/**
 * Replies to a form through the local OpenCode service API. The server half of a plugin has no form call
 * of its own, so a reply used to need a TUI to make it; the service the server runs as does not.
 */
import { log } from "./logger.ts"

type Endpoint = {
  url: string
  auth?: { type: "basic"; username: string; password: string }
}

type Api = {
  permission: {
    get(i: { sessionID: string; requestID: string }): Promise<unknown>
  }
  session: {
    form: {
      get(i: {
        sessionID: string
        formID: string
      }): Promise<{ state?: { status?: string } }>
      reply(i: {
        sessionID: string
        formID: string
        answer: never
      }): Promise<void>
    }
  }
}

export type ServiceClient = {
  /** Whether the service answers now: a form reply can be delivered without a TUI. */
  ready(): Promise<boolean>
  reply(r: {
    sessionID: string
    formID: string
    answer: unknown
  }): Promise<void>
  /**
   * What the service says of a form or permission request: still `open`, or already `answered` or
   * `cancelled` (a request it no longer has counts as answered). Undefined when it cannot say.
   */
  state(
    kind: "question" | "permission",
    sessionID: string,
    requestID: string,
  ): Promise<"open" | "answered" | "cancelled" | "gone" | undefined>
}

const loopback = (url: string) => url.replace("//0.0.0.0", "//127.0.0.1")

async function defaultDiscover(): Promise<Endpoint | undefined> {
  const { Service } = await import("@opencode/client/service")
  const e = await Service.discover()
  return e && { ...e, url: loopback(e.url) }
}

async function defaultMake(e: Endpoint): Promise<Api> {
  const [{ OpenCode }, { Service }] = await Promise.all([
    import("@opencode/client"),
    import("@opencode/client/service"),
  ])
  return OpenCode.make({
    baseUrl: e.url,
    headers: Service.headers(e as never) as never,
  }) as unknown as Api
}

/** Finds the service lazily and keeps the answer for `ttlMs`, so a restart of the service is found again. */
export function serviceClient(
  o: {
    discover?: () => Promise<Endpoint | undefined>
    make?: (e: Endpoint) => Api | Promise<Api>
    ttlMs?: number
    now?: () => number
  } = {},
): ServiceClient {
  const discover = o.discover ?? defaultDiscover
  const make = o.make ?? defaultMake
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? 30_000
  let cached: { api: Api | undefined; at: number } | undefined

  async function api(): Promise<Api | undefined> {
    if (cached && now() - cached.at < ttl && cached.api) return cached.api
    try {
      const e = await discover()
      cached = { api: e ? await make(e) : undefined, at: now() }
    } catch (err) {
      log("service_discover_failed", { message: (err as Error).message })
      cached = { api: undefined, at: now() - ttl + 5_000 }
    }
    return cached.api
  }

  return {
    async ready() {
      return (await api()) !== undefined
    },
    async state(kind, sessionID, requestID) {
      const a = await api()
      if (!a) return undefined
      try {
        if (kind === "permission") {
          await a.permission.get({ sessionID, requestID })
          return "open"
        }
        const f = await a.session.form.get({ sessionID, formID: requestID })
        const s = f.state?.status
        return s === "answered" || s === "cancelled" ? s : "open"
      } catch (err) {
        const tag = (err as { _tag?: string })._tag
        // Only these two say the request is gone; any other failure says nothing. A form gone
        // is not known to be answered (a tool may have been interrupted); a permission is.
        if (tag === "FormNotFoundError") return "gone"
        return tag === "PermissionNotFoundError" ? "answered" : undefined
      }
    },
    async reply(r) {
      const a = await api()
      if (!a) throw new Error("The OpenCode service did not answer")
      try {
        await a.session.form.reply(r as never)
      } catch (err) {
        cached = undefined
        throw err
      }
    },
  }
}

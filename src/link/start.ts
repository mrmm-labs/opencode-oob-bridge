/** Wires the link into the server: what a relayed request is checked against, and the client. */
import type { Bridge } from "../bridge.ts"
import type { Config } from "../config.ts"
import type { ApiDeps } from "../core/api.ts"
import type { Core } from "../core/index.ts"
import { log } from "../logger.ts"
import { resolveToken, type TokenSource } from "../token.ts"
import { isObject } from "../util.ts"
import { LinkClient } from "./client.ts"

/** The paired operator's numeric Telegram id, when there is one. */
export function operatorId(bridge: Bridge): number | undefined {
  const raw = bridge
    .connectors()
    .find((c) => c.type === "telegram")
    ?.operator?.()
  const n = Number(raw)
  return raw !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function botTokenSource(cfg: Config): TokenSource | undefined {
  for (const c of Object.values(cfg.channels))
    if (
      c.type === "telegram" &&
      c.enabled &&
      isObject(c.options) &&
      c.options.token
    )
      return c.options.token as TokenSource
  return undefined
}

/** The bot token stays on this machine: it is read here, and only to check init data. */
export function edgeAuth(cfg: Config, bridge: Bridge) {
  let token: string | undefined
  const edge: NonNullable<ApiDeps["edge"]> = {
    operator: () => operatorId(bridge),
    botToken: () => token,
    maxAgeSeconds: cfg.miniApp.maxAgeSeconds,
  }
  return {
    edge,
    async refresh(): Promise<void> {
      if (token) return
      token = await resolveToken(botTokenSource(cfg)).catch((err: Error) => {
        log("link_bot_token_error", { message: err.message })
        return undefined
      })
    },
  }
}

/** Starts the link when `link.url` is set. The secret and the bot token are read when a connection is made. */
export function startLink(o: {
  cfg: Config
  core: Core
  edge: ReturnType<typeof edgeAuth>
}): LinkClient | undefined {
  const url = o.cfg.link.url
  if (!url) return undefined
  let secret: string | undefined
  const client = new LinkClient({
    url,
    secret: async () => {
      await o.edge.refresh()
      if (secret) return secret
      if (!o.cfg.link.secret) {
        log("link_waiting", { reason: "link.secret is not set" })
        return undefined
      }
      secret = await resolveToken(o.cfg.link.secret)
      return secret
    },
    handler: (req, res, edge) => o.core.handle(req, res, edge),
  })
  client.start()
  return client
}

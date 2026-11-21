/** Everything a deployment sets comes from the environment. A secret may also be read from a file (`NAME_FILE`). */
import { readFileSync } from "node:fs"

export type Config = {
  bind: string
  port: number
  linkPort: number
  metricsPort: number
  linkSecret: string
  linkMaxSkewSeconds: number
  operatorUserId?: number
  verifyToken?: string
  maxAgeSeconds: number
  maxBodyBytes: number
  sseKeepaliveSeconds: number
  requestTimeoutSeconds: number
  clientIpHeader?: string
  rate: { perSecond: number; burst: number }
  beatPerSecond: number
  maxInFlightPerClient: number
  maxInFlightTotal: number
  heartbeatToken?: string
  alert: { token?: string; chatId?: string; apiBase: string }
  deadman: {
    intervalSeconds: number
    missedBeats: number
    stoppingGraceSeconds: number
    reminderSeconds: number
  }
}

export type Loaded = { config: Config; warnings: string[] } | { error: string }

type Env = Record<string, string | undefined>

const MIN_SECRET = 32

export function loadConfig(
  env: Env = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): Loaded {
  const problems: string[] = []
  const warnings: string[] = []

  const text = (name: string): string | undefined => {
    const file = env[name + "_FILE"]
    if (file) {
      try {
        const v = read(file).trim()
        return v === "" ? undefined : v
      } catch {
        problems.push(`${name}_FILE cannot be read`)
        return undefined
      }
    }
    const v = env[name]?.trim()
    return v === "" ? undefined : v
  }
  const int = (name: string, d: number, min: number, max: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === "") return d
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`)
      return d
    }
    return n
  }

  const linkSecret = text("LINK_SECRET")
  if (!linkSecret) problems.push("LINK_SECRET is required")
  else if (linkSecret.length < MIN_SECRET)
    problems.push(`LINK_SECRET must be at least ${MIN_SECRET} characters`)

  const op = text("OPERATOR_USER_ID")
  let operatorUserId: number | undefined
  if (op !== undefined && /^[1-9][0-9]{0,15}$/.test(op))
    operatorUserId = Number(op)
  else
    warnings.push(
      op === undefined
        ? "OPERATOR_USER_ID is not set: every /v1 request is refused"
        : "OPERATOR_USER_ID is not a Telegram user id: every /v1 request is refused",
    )

  const verifyToken = text("TELEGRAM_BOT_TOKEN_VERIFY")
  if (!verifyToken)
    warnings.push(
      "TELEGRAM_BOT_TOKEN_VERIFY is not set: init data is checked for shape, user and age only, the bridge checks the hash",
    )

  const header = env.CLIENT_IP_HEADER?.trim()
  if (header !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(header))
    problems.push("CLIENT_IP_HEADER must be a header name")

  const alertToken = text("TELEGRAM_BOT_TOKEN")
  const chatId = text("TELEGRAM_CHAT_ID")
  if (!alertToken || !chatId)
    warnings.push(
      "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set: dead-man alerts are only logged",
    )
  const apiBase = (env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(
    /\/+$/,
    "",
  )
  if (!/^https?:\/\//.test(apiBase))
    problems.push("TELEGRAM_API_BASE must be a URL")

  const heartbeatToken = text("HEARTBEAT_TOKEN")
  if (heartbeatToken !== undefined && heartbeatToken.length < MIN_SECRET)
    problems.push(`HEARTBEAT_TOKEN must be at least ${MIN_SECRET} characters`)
  if (!heartbeatToken)
    warnings.push("HEARTBEAT_TOKEN is not set: POST /beat is off")

  const config: Config = {
    bind: env.BIND_ADDRESS?.trim() || "0.0.0.0",
    port: int("PORT", 8080, 1, 65535),
    linkPort: int("LINK_PORT", 8081, 1, 65535),
    metricsPort: int("METRICS_PORT", 9090, 1, 65535),
    linkSecret: linkSecret ?? "",
    linkMaxSkewSeconds: int("LINK_MAX_SKEW_SECONDS", 60, 1, 60),
    operatorUserId,
    verifyToken,
    maxAgeSeconds: int("MAX_AGE_SECONDS", 3600, 1, 86_400),
    maxBodyBytes: int("MAX_BODY_BYTES", 262_144, 1, 262_144),
    sseKeepaliveSeconds: int("SSE_KEEPALIVE_SECONDS", 25, 1, 3600),
    requestTimeoutSeconds: int("REQUEST_TIMEOUT_SECONDS", 60, 1, 600),
    clientIpHeader: header || undefined,
    rate: {
      perSecond: int("RATE_LIMIT_PER_SECOND", 20, 1, 10_000),
      burst: int("RATE_LIMIT_BURST", 40, 1, 10_000),
    },
    beatPerSecond: int("BEAT_RATE_PER_SECOND", 5, 1, 1000),
    maxInFlightPerClient: int("MAX_IN_FLIGHT_PER_CLIENT", 20, 1, 1000),
    maxInFlightTotal: int("MAX_IN_FLIGHT_TOTAL", 16, 1, 1000),
    heartbeatToken,
    alert: { token: alertToken, chatId, apiBase },
    deadman: {
      intervalSeconds: int("INTERVAL_SECONDS", 30, 1, 3600),
      missedBeats: int("MISSED_BEATS", 3, 1, 100),
      stoppingGraceSeconds: int("STOPPING_GRACE_SECONDS", 300, 1, 86_400),
      reminderSeconds: int("REMINDER_SECONDS", 1800, 1, 86_400),
    },
  }
  return problems.length ? { error: problems.join("; ") } : { config, warnings }
}

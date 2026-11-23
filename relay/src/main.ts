import { createServer } from "node:http"

import { loadConfig } from "./config.ts"
import { Deadman, parseBeat, telegramSender } from "./deadman.ts"
import { Link } from "./link.ts"
import { log } from "./log.ts"
import { render } from "./metrics.ts"
import { publicHandler } from "./public.ts"

const loaded = loadConfig()
if ("error" in loaded) {
  log("config_error", { problems: loaded.error })
  process.exit(2)
}
const { config: cfg, warnings } = loaded
for (const w of warnings) log("config_warning", { warning: w })

const deadman = new Deadman({
  now: Date.now,
  send: telegramSender(cfg.alert),
  intervalMs: cfg.deadman.intervalSeconds * 1000,
  missed: cfg.deadman.missedBeats,
  stoppingMs: cfg.deadman.stoppingGraceSeconds * 1000,
  reminderMs: cfg.deadman.reminderSeconds * 1000,
})

const link = new Link({
  secret: cfg.linkSecret,
  key: cfg.linkKey,
  channels: cfg.linkChannels,
  maxSkewMs: cfg.linkMaxSkewSeconds * 1000,
  keepAliveMs: cfg.sseKeepaliveSeconds * 1000,
  requestTimeoutMs: cfg.requestTimeoutSeconds * 1000,
  onBeat: (b) => {
    const parsed = parseBeat(b)
    if (parsed) deadman.beat(parsed)
  },
})

const pub = createServer(publicHandler({ cfg, link, deadman }))
pub.headersTimeout = 30_000
const linkServer = link.server()
const metrics = createServer((req, res) => {
  if (req.method === "GET" && (req.url ?? "").split("?")[0] === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" })
    return void res.end(render(deadman, link))
  }
  res.writeHead(404)
  res.end()
})

const listen = (s: ReturnType<typeof createServer>, port: number) =>
  new Promise<void>((ok, fail) => {
    s.once("error", fail)
    s.listen(port, cfg.bind, () => ok())
  })

try {
  await Promise.all([
    listen(pub, cfg.port),
    listen(linkServer, cfg.linkPort),
    listen(metrics, cfg.metricsPort),
  ])
} catch (err) {
  log("listen_error", { error: (err as Error).message })
  process.exit(2)
}
deadman.start()
log("started", {
  port: cfg.port,
  linkPort: cfg.linkPort,
  metricsPort: cfg.metricsPort,
  hashCheck: cfg.verifyToken !== undefined,
  operator: cfg.operatorUserId !== undefined,
  alerts: cfg.alert.token !== undefined && cfg.alert.chatId !== undefined,
  beatEndpoint: cfg.heartbeatToken !== undefined,
  channels: Object.keys(cfg.linkChannels).join(","),
})

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  log("stopping")
  deadman.stop()
  link.close()
  for (const s of [pub, linkServer, metrics]) {
    s.close()
    s.closeAllConnections()
  }
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
process.on("unhandledRejection", (e) =>
  log("unhandled_rejection", { error: (e as Error)?.name ?? "error" }),
)

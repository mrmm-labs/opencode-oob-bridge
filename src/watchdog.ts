/**
 * Notices a receive loop that has stopped making progress while the server
 * stays up, and restarts the bridge. The restart keeps the process lock, so
 * there is still exactly one poller. Nothing here waits on a channel.
 */
import type { ConnectorStatus } from "./connectors/types.ts"
import { log } from "./logger.ts"

import { STALL_MS } from "./util.ts"

export const WATCH_MS = 30_000

export type WatchChannel = ConnectorStatus & { id: string; enabled: boolean }

export type WatchdogOptions = {
  channels(): WatchChannel[]
  restart(): Promise<void>
  stallMs?: number
  everyMs?: number
}

export function startWatchdog(o: WatchdogOptions): () => void {
  const limit = o.stallMs ?? STALL_MS
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    const stuck = o
      .channels()
      .find((c) => c.enabled && (c.silentMs ?? 0) > limit)
    if (!stuck) return
    busy = true
    log("bridge_stalled", {
      channel: stuck.id,
      silent_s: Math.round((stuck.silentMs ?? 0) / 1000),
      last_poll_ok_s: age(stuck.pollOkAt),
      last_send_ok_s: age(stuck.sendOkAt),
      step: "receive loop",
    })
    void o
      .restart()
      .catch((err: Error) =>
        log("bridge_restart_failed", { message: err.message }),
      )
  }, o.everyMs ?? WATCH_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

const age = (at: number | undefined) =>
  at === undefined ? undefined : Math.round((Date.now() - at) / 1000)

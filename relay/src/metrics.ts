/** The three dead-man metrics, plus two about the link, in Prometheus text format. */
import { SHOWN, type Deadman } from "./deadman.ts"

export type LinkStats = {
  up(): boolean
  refused(): Record<string, number>
  channelStates?(): Record<string, boolean>
}

export function render(d: Deadman, link: LinkStats): string {
  const shown = d.shown()
  const lines = [
    "# HELP oob_bridge_last_heartbeat_timestamp_seconds Unix time of the last heartbeat, 0 when none arrived since the relay started.",
    "# TYPE oob_bridge_last_heartbeat_timestamp_seconds gauge",
    `oob_bridge_last_heartbeat_timestamp_seconds ${(d.lastBeatAt() ?? 0) / 1000}`,
    "# HELP oob_bridge_state The bridge as the relay sees it: 1 for the current state.",
    "# TYPE oob_bridge_state gauge",
    ...SHOWN.map(
      (s) => `oob_bridge_state{state="${s}"} ${s === shown ? 1 : 0}`,
    ),
    "# HELP oob_bridge_consecutive_missed Heartbeat intervals missed since the last heartbeat.",
    "# TYPE oob_bridge_consecutive_missed gauge",
    `oob_bridge_consecutive_missed ${d.consecutiveMissed()}`,
    "# HELP oob_relay_link_up 1 while a bridge is connected on the link.",
    "# TYPE oob_relay_link_up gauge",
    `oob_relay_link_up ${link.up() ? 1 : 0}`,
    ...(link.channelStates
      ? [
          "# HELP oob_relay_channel_up 1 while a client is connected on a named channel.",
          "# TYPE oob_relay_channel_up gauge",
          ...Object.entries(link.channelStates()).map(
            ([c, up]) => `oob_relay_channel_up{channel="${c}"} ${up ? 1 : 0}`,
          ),
        ]
      : []),
    "# HELP oob_relay_frames_refused_total Upgrades and frames refused on the link, by reason.",
    "# TYPE oob_relay_frames_refused_total counter",
    ...Object.entries(link.refused()).map(
      ([r, n]) => `oob_relay_frames_refused_total{reason="${r}"} ${n}`,
    ),
  ]
  return lines.join("\n") + "\n"
}

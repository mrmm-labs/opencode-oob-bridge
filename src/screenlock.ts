/** Whether the screen is locked, asked of the OS: only used when `away.lock` is on. */
import { execFile } from "node:child_process"

const POLL_MS = 10_000

/** macOS: the session dictionary of the I/O registry says `CGSSessionScreenIsLocked`. */
export const parseLocked = (ioreg: string): boolean =>
  /"CGSSessionScreenIsLocked"\s*=\s*(Yes|1|true)/i.test(ioreg) ||
  /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(ioreg)

const ask = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: 3000 }, (err, out) =>
      resolve(err ? "" : String(out)),
    ),
  )

/** Polls the OS now and then, never through a shell. The answer is the last one read; false where unknown. */
export function watchLock(): { locked(): boolean; stop(): void } {
  let locked = false
  const poll = async () => {
    if (process.platform === "darwin")
      locked = parseLocked(await ask("ioreg", ["-n", "Root", "-d1", "-a"]))
    else if (process.platform === "linux")
      locked = /LockedHint=yes/.test(
        await ask("loginctl", ["show-session", "self", "-p", "LockedHint"]),
      )
  }
  void poll()
  const t = setInterval(() => void poll(), POLL_MS)
  t.unref?.()
  return { locked: () => locked, stop: () => clearInterval(t) }
}

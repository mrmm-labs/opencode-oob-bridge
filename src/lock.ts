/**
 * One bridge per OpenCode server. The owner holds `owner.lock` in the data
 * directory, refreshes it while it lives, and a second loader (another
 * location of the same server, another process) does nothing.
 */
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, unlink, utimes } from "node:fs/promises"
import { dirname } from "node:path"

import { log } from "./logger.ts"

/** `id` names this holder; a lock file written by an older version has none. */
export type Owner = { pid: number; startedAt: number; id?: string }

export const BEAT_MS = 10_000
export const STALE_MS = 30_000

/** Files this process holds: a second loader here must not take the lock from the first. */
const held = new Set<string>()

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function read(
  file: string,
): Promise<(Owner & { at: number }) | undefined> {
  try {
    const [text, st] = await Promise.all([
      readFile(file, "utf8"),
      import("node:fs/promises").then((m) => m.stat(file)),
    ])
    const v = JSON.parse(text) as Partial<Owner>
    if (typeof v.pid !== "number" || typeof v.startedAt !== "number")
      return undefined
    return {
      pid: v.pid,
      startedAt: v.startedAt,
      id: typeof v.id === "string" ? v.id : undefined,
      at: st.mtimeMs,
    }
  } catch {
    return undefined
  }
}

export type Lock =
  | { held: true; owner: Owner; release(): Promise<void> }
  | { held: false; owner?: Owner }

/**
 * Takes the lock if nobody holds it, or the holder is gone (dead process, or
 * a lock not refreshed for `staleMs`). The loser gets who holds it.
 */
export async function acquire(
  file: string,
  o: { now?: () => number; staleMs?: number; beatMs?: number } = {},
): Promise<Lock> {
  const now = o.now ?? Date.now
  const staleMs = o.staleMs ?? STALE_MS
  await mkdir(dirname(file), { recursive: true })
  const mine: Owner = {
    pid: process.pid,
    startedAt: now(),
    id: randomUUID().slice(0, 8),
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, "wx")
      await fh.writeFile(JSON.stringify(mine))
      await fh.close()
      const back = await read(file)
      if (back?.pid !== mine.pid || back.startedAt !== mine.startedAt) break
      held.add(file)
      const beat = setInterval(() => {
        const t = new Date()
        void utimes(file, t, t).catch(() => {})
      }, o.beatMs ?? BEAT_MS)
      beat.unref?.()
      return {
        held: true,
        owner: mine,
        async release() {
          clearInterval(beat)
          held.delete(file)
          const cur = await read(file)
          if (cur?.pid === mine.pid && cur.startedAt === mine.startedAt)
            await unlink(file).catch(() => {})
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        log("lock_error", { message: (err as Error).message })
        return { held: false }
      }
    }
    const cur = await read(file)
    const mineHere = cur?.pid === process.pid && held.has(file)
    const stale =
      !mineHere &&
      (cur === undefined || !alive(cur.pid) || now() - cur.at > staleMs)
    if (!stale)
      return {
        held: false,
        owner: cur && { pid: cur.pid, startedAt: cur.startedAt, id: cur.id },
      }
    await unlink(file).catch(() => {})
  }
  return { held: false, owner: (await read(file)) ?? undefined }
}

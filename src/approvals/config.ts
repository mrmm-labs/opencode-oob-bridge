/** The `approvals` section of the config file (docs/approvals.md section 6). Off unless `enabled` is true. */
import { isObject } from "../util.ts"
import { CALLER_NAME } from "./callers.ts"
import { DEFAULT_FACTORS, isFactor, type Factor } from "./factors.ts"

export type ClassConfig = {
  level: 1 | 2 | 3
  /** Connector instance names or types that may carry the request. */
  channels: string[]
  /** Longest a request of this class may wait, in seconds. */
  maxTtl: number
}

export type ApprovalsConfig = {
  enabled: boolean
  defaultTtl: number
  /** Seconds a repeated request is answered with deny after a deny. */
  cooldown: number
  /** What proves level 2, in the order it is offered. */
  l2: { factors: Factor[] }
  classes: Record<string, ClassConfig>
  callers: Record<string, { classes: string[] }>
  limits: { pending: number; perHour: number; global: number }
}

export const CLASS_NAME = /^[a-z][a-z0-9._-]{0,63}$/
export const DEFAULT_LIMITS = { pending: 3, perHour: 12, global: 30 }

export const OFF: ApprovalsConfig = {
  enabled: false,
  defaultTtl: 120,
  cooldown: 120,
  l2: { factors: DEFAULT_FACTORS },
  classes: {},
  callers: {},
  limits: DEFAULT_LIMITS,
}

const int = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi

export function parseApprovals(
  raw: unknown,
): ApprovalsConfig | { error: string } {
  if (raw === undefined) return OFF
  if (!isObject(raw)) return { error: "approvals must be an object" }
  const { enabled = false, defaultTtl = 120, cooldown = 120 } = raw
  if (typeof enabled !== "boolean")
    return { error: "approvals.enabled must be true or false" }
  if (!int(defaultTtl, 10, 600))
    return { error: "approvals.defaultTtl must be 10 to 600 seconds" }
  if (!int(cooldown, 0, 3600))
    return { error: "approvals.cooldown must be 0 to 3600 seconds" }

  let factors = DEFAULT_FACTORS
  if (raw.l2 !== undefined) {
    if (!isObject(raw.l2)) return { error: "approvals.l2 must be an object" }
    const f = raw.l2.factors
    if (f !== undefined) {
      const at = "approvals.l2.factors"
      if (!Array.isArray(f) || f.length === 0)
        return { error: `${at} must list at least one factor` }
      for (const x of f) {
        if (x === "push")
          return { error: `${at}: push is level 1 only and cannot prove L2` }
        if (!isFactor(x))
          return {
            error: `${at}: unknown factor ${String(x)} (biometric, passkey, totp)`,
          }
      }
      if (new Set(f).size !== f.length)
        return { error: `${at} lists a factor twice` }
      factors = f as Factor[]
    }
  }

  const classes: ApprovalsConfig["classes"] = {}
  if (raw.classes !== undefined && !isObject(raw.classes))
    return { error: "approvals.classes must be an object" }
  for (const [name, c] of Object.entries(raw.classes ?? {})) {
    const at = `approvals.classes.${name}`
    if (!CLASS_NAME.test(name))
      return {
        error: `${at}: a class name is lowercase letters, digits, . - and _`,
      }
    if (!isObject(c)) return { error: `${at} must be an object` }
    if (c.level !== 1 && c.level !== 2 && c.level !== 3)
      return { error: `${at}.level must be 1, 2 or 3` }
    const channels = c.channels ?? ["telegram"]
    if (
      !Array.isArray(channels) ||
      channels.length === 0 ||
      !channels.every((x) => typeof x === "string" && x !== "")
    )
      return { error: `${at}.channels must list channel names` }
    const maxTtl = c.maxTtl ?? 600
    if (!int(maxTtl, 10, 3600))
      return { error: `${at}.maxTtl must be 10 to 3600 seconds` }
    classes[name] = {
      level: c.level,
      channels: channels as string[],
      maxTtl: maxTtl as number,
    }
  }

  const callers: ApprovalsConfig["callers"] = {}
  if (raw.callers !== undefined && !isObject(raw.callers))
    return { error: "approvals.callers must be an object" }
  for (const [name, c] of Object.entries(raw.callers ?? {})) {
    const at = `approvals.callers.${name}`
    if (!CALLER_NAME.test(name))
      return { error: `${at}: a caller name is 1 to 32 of a-z, 0-9, - and _` }
    if (
      !isObject(c) ||
      !Array.isArray(c.classes) ||
      !c.classes.every((x) => typeof x === "string")
    )
      return { error: `${at}.classes must list class names` }
    for (const k of c.classes)
      if (!classes[k]) return { error: `${at}.classes: no such class ${k}` }
    callers[name] = { classes: c.classes as string[] }
  }

  const limits = { ...DEFAULT_LIMITS }
  if (raw.limits !== undefined) {
    if (!isObject(raw.limits))
      return { error: "approvals.limits must be an object" }
    for (const k of ["pending", "perHour", "global"] as const) {
      const v = raw.limits[k]
      if (v === undefined) continue
      if (!int(v, 1, 1000))
        return { error: `approvals.limits.${k} must be 1 to 1000` }
      limits[k] = v as number
    }
  }
  return {
    enabled,
    defaultTtl: defaultTtl as number,
    cooldown: cooldown as number,
    l2: { factors },
    classes,
    callers,
    limits,
  }
}

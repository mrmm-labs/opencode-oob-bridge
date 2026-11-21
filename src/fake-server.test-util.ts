/**
 * A stand-in for the OpenCode server's plugin context: enough of it to run the
 * server half (src/server.ts) in a test, push events at it, and let a fake TUI
 * call its RPC and receive its RPC events.
 */
import type { Plugin } from "@opencode/plugin"

type Fn = (input: unknown) => Promise<unknown>

export type FakeServer = ReturnType<typeof fakeServer>

/** Never the service of the machine the tests run on: no service unless a test names one. */
export const noService = {
  ready: async () => false,
  reply: async () => {
    throw new Error("no service in tests")
  },
}

/** What the host demands of an RPC answer or event: JSON values only, so no `undefined` keys. */
function assertJson(v: unknown, path = "$"): void {
  if (v === undefined || typeof v === "function" || typeof v === "bigint")
    throw new Error("Expected JSON value at " + path)
  if (typeof v === "number" && !Number.isFinite(v))
    throw new Error("Expected JSON value at " + path)
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) assertJson(x, path + "." + k)
}

export function fakeServer(
  sessions: Record<string, Record<string, unknown>> = {
    root: {
      id: "root",
      agent: "coordinator",
      location: { directory: "/w/shop" },
      title: "T",
    },
  },
) {
  const queue: Array<{ type: string; data: unknown }> = []
  let wake: (() => void) | undefined
  const handlers = new Map<string, Fn>()
  const tuiEvents = new Map<string, (e: { data?: unknown }) => void>()
  const prompts: Array<Record<string, unknown>> = []
  const synthetics: Array<Record<string, unknown>> = []
  const calls: Array<[string, unknown]> = []
  let registrations = 0
  let disposed = 0
  const opts = { resume: true }
  /** Sessions the host never answers `get` for. */
  const hang = new Set<string>()

  const ctx = {
    location: { directory: "/w/shop" },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (hang.has(sessionID)) return new Promise<never>(() => {})
        const s = sessions[sessionID]
        if (!s) throw new Error("not found")
        return s
      },
      prompt: async (i: Record<string, unknown>) => void prompts.push(i),
      synthetic: async (i: Record<string, unknown>) => {
        if (!opts.resume) throw new Error("cannot resume")
        synthetics.push(i)
      },
      create: async (i: unknown) => {
        calls.push(["create", i])
        return { id: "ses_new" }
      },
      switchModel: async (i: unknown) => void calls.push(["switchModel", i]),
      switchAgent: async (i: unknown) => void calls.push(["switchAgent", i]),
      interrupt: async (i: unknown) => {
        calls.push(["interrupt", i])
        return { interrupted: true }
      },
      compact: async (i: unknown) => void calls.push(["compact", i]),
      update: async (i: unknown) => void calls.push(["update", i]),
    },
    agent: { list: async () => ({ data: [] }) },
    model: { list: async () => ({ data: [] }) },
    event: {
      subscribe: async function* (o: { signal?: AbortSignal }) {
        while (!o.signal?.aborted) {
          const e = queue.shift()
          if (e) {
            yield e
            continue
          }
          await new Promise<void>((r) => {
            wake = r
            o.signal?.addEventListener("abort", () => r(), { once: true })
          })
        }
      },
    },
    rpc: {
      register: async (_def: unknown, h: Record<string, Fn>) => {
        registrations++
        for (const [k, v] of Object.entries(h)) handlers.set(k, v)
        return {
          dispose: async () => {
            disposed++
            handlers.clear()
          },
          events: {
            emit: async (name: string, data: unknown) => {
              assertJson(data)
              tuiEvents.get("rpc.oob-bridge." + name)?.({ data })
            },
          },
        }
      },
    },
  }

  return {
    ctx: ctx as unknown as Plugin.Context,
    sessions,
    hang,
    prompts,
    synthetics,
    calls,
    /** Makes `session.synthetic` fail, as a host without a way to resume would. */
    noResume: () => void (opts.resume = false),
    emit(type: string, data: unknown) {
      queue.push({ type, data })
      wake?.()
    },
    /** What a TUI's `ctx.client.rpc.call` reaches. */
    call: async ({ method, input }: { method: string; input: unknown }) => {
      const h = handlers.get(method)
      if (!h) throw new Error("RPC is unavailable: oob-bridge")
      const output = await h(input)
      assertJson(output)
      return { output }
    },
    /** What a TUI's `ctx.data.on` registers for RPC events. */
    onTui(type: string, fn: (e: { data?: unknown }) => void) {
      tuiEvents.set(type, fn)
      return () => void tuiEvents.delete(type)
    },
    registrations: () => registrations,
    disposed: () => disposed,
  }
}

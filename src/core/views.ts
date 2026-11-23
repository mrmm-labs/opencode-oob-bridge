/**
 * What clients see of the instance: session summaries and details. A field that
 * is not always available is filled from the first source that can answer and
 * says which one; when none can, it says why instead of coming back empty.
 */
import type { Bridge, Host } from "../bridge.ts"
import type { Config } from "../config.ts"
import type { Control } from "../control.ts"
import { redact } from "../filter.ts"
import type { Pending } from "../pending.ts"
import type { Snapshot } from "../rpc.ts"

export type Field<T> = { value: T; source: string } | { unavailable: string }

export type Message = { role: string; text: string; at: number }
export type DiffFile = {
  file: string
  status: string
  additions: number
  deletions: number
  patch: string
}
export type Todo = { text: string; done: boolean }

/** One rung of the ladder: a named source, or `undefined` when it cannot exist here. */
export type Rung<T, A = undefined> = [
  name: string,
  fn: ((sessionID: string, arg: A) => Promise<T | undefined>) | undefined,
]

/** The sources, best first: the server context, the event cache, the database probe, a TUI relay. */
export type Sources = {
  /** The argument is how many messages are wanted. */
  tail: Array<Rung<Message[], number>>
  /** The argument is the session's folder. */
  diff: Array<Rung<DiffFile[], string | undefined>>
  todos: Array<Rung<Todo[]>>
}

export async function ladder<T, A>(
  rungs: Array<Rung<T, A>>,
  id: string,
  arg: A,
): Promise<Field<T>> {
  const why: string[] = []
  for (const [name, fn] of rungs) {
    if (!fn) {
      why.push(name + ": not available here")
      continue
    }
    try {
      const v = await fn(id, arg)
      if (v !== undefined) return { value: v, source: name }
      why.push(name + ": no data")
    } catch (err) {
      why.push(name + ": " + (err as Error).message)
    }
  }
  return { unavailable: why.join("; ") || "no source" }
}

export type Summary = {
  id: string
  title?: string
  agent?: string
  model?: string
  variant?: string
  project?: string
  /** The last part of the session's directory: all the phone gets of the path. */
  folder?: string
  state: "working" | "idle" | "failed" | "unstarted" | "suspended"
  watch: { mode: "on" | "off" | "auto"; channel?: string }
  chat: boolean
  lastActivity?: number
  pending: number
  stuck: boolean
  /** Why `chat.deny` blocks the session, if it does. */
  blocked?: string
}

export type Detail = Summary & {
  tail: Field<Message[]>
  todos: Field<Todo[]>
  diff: Field<{
    files: Array<Omit<DiffFile, "patch">>
    additions: number
    deletions: number
  }>
  /** False when no window can take a form reply: answer at the Mac. */
  canAnswer: boolean
  questions: Array<{
    id: string
    title: string
    askedAt: number
    items: Array<{
      key: string
      header: string
      text: string
      options: string[]
      multiple: boolean
      custom: boolean
    }>
  }>
  permissions: Array<{ id: string; title: string; askedAt: number }>
}

export type ViewsDeps = {
  control: Control
  bridge: Bridge
  host: Host
  cfg: Config
  sources: Sources
}

const TAIL = 20

/** The last part of a path, whichever way it is written; undefined for none. */
export function folderOf(dir: string | undefined): string | undefined {
  const last = dir?.split(/[\\/]/).filter(Boolean).pop()
  return last ? last.slice(0, 60) : undefined
}
const MAX_TAIL = 200

export class Views {
  private readonly o: ViewsDeps

  constructor(o: ViewsDeps) {
    this.o = o
  }

  private text(s: string): string {
    return redact(s, this.o.cfg.redact)
  }

  private rows(snap: Snapshot): Summary[] {
    const { bridge } = this.o
    const states = new Map(bridge.known().map((k) => [k.id, k.state]))
    return snap.sessions.map((r) => {
      const st = states.get(r.id)
      const stuck = snap.stuck.some((s) => s.id === r.id)
      const known = this.o.host.peek?.(r.id)
      const title = r.title || known?.title
      return {
        id: r.id,
        title: title ? this.text(title) : undefined,
        folder: folderOf(known?.directory),
        agent: r.agent ?? st?.agent,
        model: st?.model,
        variant: st?.variant,
        project: r.project,
        state: stuck
          ? "suspended"
          : r.busy
            ? "working"
            : st?.unstarted
              ? "unstarted"
              : st?.state === "failed"
                ? "failed"
                : "idle",
        watch: { mode: r.mode, channel: r.channel },
        chat: r.chat,
        lastActivity: st?.at,
        pending: r.prompts.length,
        stuck,
        blocked: r.blocked,
      }
    })
  }

  list(
    limit = 50,
    offset = 0,
  ): { sessions: Summary[]; total: number; next?: number } {
    const all = this.rows(this.o.control.snapshot()).sort(
      (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0),
    )
    const sessions = all.slice(offset, offset + limit)
    return {
      sessions,
      total: all.length,
      ...(offset + limit < all.length ? { next: offset + limit } : {}),
    }
  }

  private async summary(id: string): Promise<Summary | undefined> {
    if (!(await this.o.host.session(id))) return undefined
    return this.rows(this.o.control.snapshot([id])).find((s) => s.id === id)
  }

  private async directory(id: string): Promise<string | undefined> {
    return (
      this.o.host.peek?.(id)?.directory ??
      (await this.o.host.session(id))?.directory
    )
  }

  async messages(
    id: string,
    limit = TAIL,
    before?: number,
  ): Promise<Field<Message[]> | undefined> {
    const s = await this.summary(id)
    if (!s) return undefined
    if (s.blocked)
      return { unavailable: "blocked by chat.deny (" + s.blocked + ")" }
    const n = Math.min(Math.max(limit, 1), MAX_TAIL)
    const f = await ladder(
      this.o.sources.tail,
      id,
      before !== undefined ? MAX_TAIL : n,
    )
    if (!("value" in f)) return f
    const kept = f.value
      .filter((m) => before === undefined || m.at < before)
      .slice(-n)
      .map((m) => ({ ...m, text: this.text(m.text) }))
    return { value: kept, source: f.source }
  }

  async diff(
    id: string,
  ): Promise<Field<DiffFile[]> | { blocked: string } | undefined> {
    const s = await this.summary(id)
    if (!s) return undefined
    if (s.blocked) return { blocked: s.blocked }
    const f = await ladder(this.o.sources.diff, id, await this.directory(id))
    if (!("value" in f)) return f
    return {
      source: f.source,
      value: f.value.map((d) => ({ ...d, patch: this.text(d.patch) })),
    }
  }

  private items(p: Pending) {
    return (p.questions ?? []).map((q) => ({
      key: q.key,
      header: this.text(q.header),
      text: this.text(q.text),
      options: q.options.map((o) => this.text(o)),
      multiple: q.multiple,
      custom: q.custom,
    }))
  }

  /** One question or permission by its short id, for a link that opens it. */
  prompt(id: string) {
    const p = this.o.bridge.promptEntry(id)
    return p
      ? {
          id: p.id,
          kind: p.kind,
          state: p.state,
          session: p.rootSessionID,
          title: this.text(p.title),
          askedAt: p.askedAt,
          items: p.kind === "question" ? this.items(p) : [],
        }
      : undefined
  }

  async detail(id: string): Promise<Detail | undefined> {
    const s = await this.summary(id)
    if (!s) return undefined
    const { bridge, sources } = this.o
    const prompts = bridge.openPromptList(id)
    const blocked: Field<never> | undefined = s.blocked
      ? { unavailable: "blocked by chat.deny (" + s.blocked + ")" }
      : undefined
    const tail = blocked ??
      (await this.messages(id)) ?? { unavailable: "no such session" }
    const todos = blocked ?? (await ladder(sources.todos, id, undefined))
    const d = blocked ?? (await this.diff(id))
    const diff: Detail["diff"] =
      d && "value" in d
        ? {
            source: d.source,
            value: {
              files: d.value.map(({ patch: _p, ...rest }) => rest),
              additions: d.value.reduce((n, x) => n + x.additions, 0),
              deletions: d.value.reduce((n, x) => n + x.deletions, 0),
            },
          }
        : d && "unavailable" in d
          ? d
          : { unavailable: "no such session" }
    return {
      ...s,
      tail,
      todos,
      diff,
      canAnswer: (await this.o.host.canReplyForm?.()) ?? true,
      questions: prompts
        .filter((p) => p.kind === "question" && p.state === "pending")
        .map((p) => ({
          id: p.id,
          title: this.text(p.title),
          askedAt: p.askedAt,
          items: this.items(p),
        })),
      permissions: prompts
        .filter((p) => p.kind === "permission" && p.state === "pending")
        .map((p) => ({
          id: p.id,
          title: this.text(p.title),
          askedAt: p.askedAt,
        })),
    }
  }

  /** Which fields can be filled now, for `/v1/meta`. */
  fields(): Record<string, string[]> {
    const names = (r: Array<Rung<unknown, never>>) =>
      r.filter(([, fn]) => fn).map(([n]) => n)
    return {
      tail: names(this.o.sources.tail),
      diff: names(this.o.sources.diff),
      todos: names(this.o.sources.todos),
    }
  }
}

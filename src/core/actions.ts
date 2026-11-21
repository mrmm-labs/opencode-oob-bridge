/**
 * The one set of actions a client can take on a session. Telegram, the TUI and
 * the HTTP API reach the host only through this class, so a refusal rule is
 * the same for all of them.
 */
import type { Config } from "../config.ts"
import type { Host, ModelOption } from "../bridge.ts"
import type { Delivery } from "../config.ts"
import type { Answer } from "../inbound.ts"
import type { InboundFile } from "../connectors/types.ts"
import { log } from "../logger.ts"

const MAX_NEW_PER_HOUR = 5
const HOUR_MS = 60 * 60_000
const MAX_MODELS = 12
const MAX_TITLE = 100

export type Result = { ok: boolean; text: string; data?: unknown }
type Facts = { agent?: string; directory?: string } | undefined

/** What the actions need besides the host: bridge-owned state, handed in. */
export type ActionDeps = {
  cfg: Config
  host: Host
  now: () => number
  /** Why `chat.deny` blocks a session, if it does. */
  denial(facts: Facts): string | undefined
  setChat(root: string, on: boolean): Promise<Result>
  setWatch(
    root: string,
    mode: "on" | "off" | "auto",
    channel?: string,
  ): Promise<Result>
  resume(root: string): Promise<Result>
  answer(
    promptId: string,
    a: { choice?: number; text?: string },
  ): Promise<Result>
  /** The remote-permissions policy: refused until a policy allows it. */
  permissions?: () => boolean
}

/** Thrown when a rule refuses an action before the host is called. */
export class Refused extends Error {}

export const ACTIONS = [
  "answer",
  "permission",
  "resume",
  "stop",
  "prompt",
  "rename",
  "compact",
  "undo",
  "model",
  "agent",
  "watch",
  "chat",
] as const
export type ActionName = (typeof ACTIONS)[number]

const no = (text: string): Result => ({ ok: false, text })
const yes = (text: string, data?: unknown): Result => ({ ok: true, text, data })
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

export class Actions {
  private readonly d: ActionDeps
  private readonly created: number[] = []

  constructor(deps: ActionDeps) {
    this.d = deps
  }

  /** Each action, and whether it can run now, for `/v1/meta`. */
  available(): Array<{
    name: ActionName
    available: boolean
    reason?: string
  }> {
    const off: Partial<Record<ActionName, string>> = {
      permission: "no policy allows permission replies from a client",
      ...(this.d.host.undo
        ? {}
        : { undo: "no source in this process can revert a session" }),
      ...(this.d.host.resume
        ? {}
        : { resume: "this OpenCode cannot resume a session from here" }),
    }
    return ACTIONS.map((name) => ({
      name,
      available: off[name] === undefined,
      ...(off[name] ? { reason: off[name] } : {}),
    }))
  }

  /** Throws `Refused` for a session that `chat.deny` blocks. */
  private async gate(root: string): Promise<void> {
    const why = this.d.denial(await this.d.host.session(root))
    if (why) throw new Refused(`Blocked by chat.deny (${why}).`)
  }

  /** The models a client may pick: the configured ones, or the first few the host lists. */
  async models(): Promise<ModelOption[]> {
    const all = await this.d.host.models().catch(() => [] as ModelOption[])
    const wanted = this.d.cfg.chat.models
    if (wanted.length)
      return wanted
        .map((ref) => all.find((x) => x.ref === ref))
        .filter((x): x is ModelOption => x !== undefined)
    return all.slice(0, MAX_MODELS)
  }

  async stop(root: string): Promise<boolean> {
    await this.gate(root)
    return this.d.host.interrupt(root)
  }

  async prompt(
    root: string,
    text: string,
    delivery: Delivery,
    files?: InboundFile[],
  ): Promise<void> {
    await this.gate(root)
    await this.d.host.prompt(root, text, delivery, files)
  }

  async compact(root: string): Promise<void> {
    await this.gate(root)
    await this.d.host.compact(root)
  }

  async rename(root: string, title: string): Promise<void> {
    await this.gate(root)
    if (!title || title.length > MAX_TITLE)
      throw new Refused(`A title is 1 to ${MAX_TITLE} characters.`)
    await this.d.host.rename(root, title)
  }

  async switchAgent(root: string, agent: string): Promise<void> {
    await this.gate(root)
    await this.d.host.switchAgent(root, agent)
  }

  async switchModel(
    root: string,
    model: { providerID: string; id: string; variant?: string },
  ): Promise<void> {
    await this.gate(root)
    await this.d.host.switchModel(root, model)
  }

  /** Wakes a session that holds messages it is not working on. */
  async wake(root: string): Promise<void> {
    await this.gate(root)
    if (!this.d.host.resume)
      throw new Refused("This OpenCode cannot resume a session from here.")
    await this.d.host.resume(root)
  }

  /** Stages a revert of the last turn through an attached TUI. True when something was reverted. */
  async undo(root: string): Promise<boolean> {
    await this.gate(root)
    if (!this.d.host.undo) throw new Refused("Undo is not available here.")
    if (this.d.host.busy(root))
      throw new Refused("Stop the running turn first, then undo.")
    try {
      return await this.d.host.undo(root)
    } catch (err) {
      log("undo_error", { message: (err as Error).message })
      throw new Refused(
        "Undo needs an OpenCode window open at the Mac: do it there.",
      )
    }
  }

  async answerForm(
    sessionID: string,
    formID: string,
    a: Answer,
  ): Promise<void> {
    await this.d.host.replyForm(sessionID, formID, a)
  }

  /**
   * Starts a session in a folder of `chat.projects`. `before` runs once the
   * session exists and before its first prompt.
   */
  async create(
    o: { project: string; agent?: string; model?: string; text: string },
    before?: (id: string) => void,
  ): Promise<Result & { outcome: string; id?: string }> {
    const out = (outcome: string, r: Result, id?: string) => ({
      ...r,
      outcome,
      id,
    })
    const projects = this.d.cfg.chat.projects
    if (!Object.hasOwn(projects, o.project))
      return out("invalid", no("Unknown project."))
    const p = projects[o.project]
    const agent = o.agent ?? p.agent
    const model = o.model ?? p.model
    if (this.d.denial({ agent, directory: p.directory }))
      return out(
        "denied",
        no("Starting a session there is blocked by chat.deny."),
      )
    const now = this.d.now()
    while (this.created.length && now - this.created[0] > HOUR_MS)
      this.created.shift()
    if (this.created.length >= MAX_NEW_PER_HOUR)
      return out(
        "limited",
        no(
          `At most ${MAX_NEW_PER_HOUR} new sessions an hour: try again later.`,
        ),
      )
    // A model given by a client must be on the list; the project's own comes from the config.
    if (
      o.model !== undefined &&
      !(await this.models()).some((x) => x.ref === o.model)
    )
      return out("invalid", no("That model is not available."))
    this.created.push(now)
    try {
      const ref = model
        ? {
            providerID: model.slice(0, model.indexOf("/")),
            id: model.slice(model.indexOf("/") + 1),
          }
        : undefined
      const { id } = await this.d.host.createSession({
        directory: p.directory,
        agent,
        model: ref,
      })
      before?.(id)
      await this.d.host.prompt(id, o.text, "queue")
      return out(
        "applied",
        yes(`Started ${o.project} · ${agent ?? "default agent"}`, { id }),
        id,
      )
    } catch (err) {
      log("session_create_error", { message: (err as Error).message })
      return out("failed", no("Could not start the session: see the log."))
    }
  }

  /** One action by name, with a JSON body. Used by the HTTP API. */
  async run(
    name: string,
    root: string,
    body: Record<string, unknown>,
  ): Promise<Result> {
    try {
      switch (name) {
        case "answer": {
          const id = str(body.prompt)
          if (!id) return no("answer needs a prompt id")
          return await this.d.answer(id, {
            choice: typeof body.choice === "number" ? body.choice : undefined,
            text: str(body.text),
          })
        }
        case "permission":
          return this.d.permissions?.()
            ? no("Permission replies are not implemented for clients yet.")
            : no(
                "Permission replies from a client are refused: no policy allows them. Answer in the OpenCode TUI.",
              )
        case "resume":
          await this.gate(root)
          return await this.d.resume(root)
        case "stop":
          return (await this.stop(root))
            ? yes("Stopped the running turn.")
            : yes("Nothing is running.")
        case "prompt": {
          const text = str(body.text)
          if (!text) return no("prompt needs text")
          const busy = this.d.host.busy(root)
          const delivery: Delivery =
            body.delivery === "steer" ? "steer" : "queue"
          await this.prompt(root, text, delivery)
          return yes(busy && delivery === "steer" ? "Steered in." : "Sent.")
        }
        case "rename": {
          await this.rename(root, str(body.title) ?? "")
          return yes("Renamed.")
        }
        case "compact":
          await this.compact(root)
          return yes("Compacting the session.")
        case "undo":
          return (await this.undo(root))
            ? yes("Reverted the last turn.")
            : yes("Nothing to undo.")
        case "model": {
          const ref = str(body.model)
          const hit = ref && (await this.models()).find((x) => x.ref === ref)
          if (!hit) return no("That model is not available.")
          const variant = str(body.variant)
          if (variant && !hit.variants.includes(variant))
            return no("That model has no such variant.")
          const i = hit.ref.indexOf("/")
          await this.switchModel(root, {
            providerID: hit.ref.slice(0, i),
            id: hit.ref.slice(i + 1),
            variant,
          })
          return yes("Model: " + hit.name)
        }
        case "agent": {
          const agent = str(body.agent)
          const list = await this.d.host.agents().catch(() => [] as string[])
          if (!agent || !list.includes(agent))
            return no("That agent is not available.")
          await this.switchAgent(root, agent)
          return yes("Agent: " + agent)
        }
        case "watch": {
          const m = body.mode
          if (m !== "on" && m !== "off" && m !== "auto")
            return no("watch is on, off or auto")
          await this.gate(root)
          return await this.d.setWatch(root, m, str(body.channel))
        }
        case "chat":
          return await this.d.setChat(root, body.on === true)
      }
    } catch (err) {
      if (err instanceof Refused) return no(err.message)
      log("action_error", { action: name, message: (err as Error).message })
      return no("The action failed: see the log.")
    }
    return no("Unknown action: " + name)
  }
}

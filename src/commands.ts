/**
 * Slash commands from a chat. The connector parses them and draws the menus;
 * this decides what they do. Two scopes: a session's topic (the command acts on
 * that session) and General or a private chat (the command acts on the plugin).
 *
 * Nothing typed in a chat is ever used as a folder or a model: a folder is a
 * key of `chat.projects`, a model is one of the listed ones, and a tap is
 * checked again against the choices that were offered.
 */
import { randomBytes } from "node:crypto"
import { basename } from "node:path"

import type { Host, ModelOption } from "./bridge.ts"
import { Refused, type Actions } from "./core/actions.ts"
import type { Config } from "./config.ts"
import type {
  Connector,
  Inbound,
  InboundFile,
  Outcome,
} from "./connectors/types.ts"
import { log } from "./logger.ts"
import type { Telemetry } from "./otel.ts"

const SESSION_COMMANDS = [
  "model",
  "agent",
  "variant",
  "status",
  "stop",
  "chat",
  "compact",
  "rename",
  "steer",
  "undo",
] as const
const GENERAL_COMMANDS = ["new", "sessions", "projects"] as const
/** Work in a session topic and in General. */
const ANYWHERE_COMMANDS = [
  "resume",
  "afk",
  "digest",
  "night",
  "version",
  "trace",
] as const
const ALIASES: Record<string, string> = { effort: "variant", start: "help" }
const KNOWN = new Set<string>([
  ...SESSION_COMMANDS,
  ...GENERAL_COMMANDS,
  ...ANYWHERE_COMMANDS,
  "help",
  "pick",
  "reply",
])

const FLOW_TTL_MS = 10 * 60_000
const MAX_FLOWS = 100
const MAX_TITLE = 100
const DEFAULT = "default"

/** What the commands need of the bridge. */
export type CommandDeps = {
  cfg: Config
  host: Host
  actions: Actions
  tel: Telemetry
  now: () => number
  chatEnabled(root: string): boolean
  denied(facts: { agent?: string; directory?: string } | undefined): boolean
  setChat(root: string, on: boolean): Promise<Outcome>
  /** Routes a new session to the connector, with chat on. */
  startChat(root: string, ch: Connector): void
  /** Makes the session's topic and status card if they do not exist, and brings them up to date. */
  show(root: string, working?: boolean): Promise<void>
  /** Mirrored sessions known to the plugin, for /sessions. */
  sessions(): Promise<Array<{ id: string; label: string }>>
  /** What /afk shows: the state, never a way to change it. */
  afk(): string
  /** What /version shows: what is installed and what each half runs. */
  version(): Promise<string>
  /** The last `n` updates and sends, one line each plus their path. */
  trace(n: number): string[]
  /** The digest text for the period since the last one, marking it covered; a refusal when the digest is off. */
  digest(): Promise<Outcome>
  /** The overnight plan in words. */
  night(): string
  /** Ends the plan; a plan is never started or changed from a chat. */
  endNight(): Promise<Outcome>
  /** Sessions with messages they are not working on. */
  stuck(): Array<{ id: string; label: string; pending: number }>
  resume(root: string): Promise<Outcome>
  /** A prompt was sent from a chat, so its turn is a remote one. */
  remote(root: string): void
  /** Posts the session's oldest open question again, at the bottom of its topic. */
  repost(root: string): Promise<Outcome>
}

type Flow = {
  kind:
    | "model"
    | "agent"
    | "variant"
    | "project"
    | "new-agent"
    | "new-model"
    | "prompt"
    | "undo"
    | "resume"
    | "held"
  exp: number
  /** The session a model, agent or variant pick is for. */
  root?: string
  /** The values that were offered; a pick is one of them. */
  values: string[]
  project?: string
  agent?: string
  model?: string
  /** A message kept while its session waits on a question. */
  held?: { text: string; files?: InboundFile[] }
}

type Info = { outcome: string; root?: string }

const no = (text: string): Outcome => ({ ok: false, text })
const yes = (text: string): Outcome => ({ ok: true, text })

/** Splits "provider/model" at the first slash. */
export function parseRef(ref: string): { providerID: string; id: string } {
  const i = ref.indexOf("/")
  return { providerID: ref.slice(0, i), id: ref.slice(i + 1) }
}

export class Commands {
  private readonly d: CommandDeps
  private readonly flows = new Map<string, Flow>()

  constructor(deps: CommandDeps) {
    this.d = deps
  }

  async run(
    ch: Connector,
    m: Inbound,
    info: Info,
  ): Promise<Outcome | undefined> {
    if (!ch.capabilities.inboundPrompt || !m.command) return undefined
    const typed = m.command.name.toLowerCase()
    const name = ALIASES[typed] ?? typed
    const span = this.d.tel.begin("oob.command", {
      session: m.sessionKey,
      attrs: {
        name: KNOWN.has(name) ? name : "unknown",
        "connector.type": ch.type,
      },
    })
    try {
      const out = await this.route(ch, m, name, info)
      span.end({ outcome: info.outcome }, out.ok ? undefined : info.outcome)
      return out
    } catch (err) {
      log("command_error", { name, message: (err as Error).message })
      info.outcome = "failed"
      span.end({ outcome: "failed" }, "error")
      return no("That did not work: see the log.")
    }
  }

  /**
   * A message for a session that waits on a question is not sent behind it
   * and not lost: it is kept, and the person chooses what happens to it.
   */
  hold(
    root: string,
    held: { text: string; files?: InboundFile[] },
    open: number,
  ): Outcome {
    return this.menu(
      "held",
      `⏸ This session is waiting on ${open === 1 ? "a question" : `${open} questions`}. ` +
        "Answer it first (reply to its message, or use its buttons), or choose:",
      [
        { label: "Answer: show the question again", value: "answer" },
        { label: "Skip: do not send my message", value: "skip" },
        { label: "Send anyway: steer it in", value: "send" },
      ],
      { root, held },
    )
  }

  private async applyHeld(
    f: Flow,
    value: string,
    info: Info,
  ): Promise<Outcome> {
    const root = f.root!
    if (value === "answer")
      return this.done(info, "applied", await this.d.repost(root))
    if (value === "skip")
      return this.done(
        info,
        "cancelled",
        yes("Skipped: your message was not sent."),
      )
    try {
      await this.d.actions.prompt(root, f.held!.text, "steer", f.held!.files)
    } catch (err) {
      return this.done(
        info,
        "failed",
        no(`Could not send that to the session: ${(err as Error).message}`),
      )
    }
    this.d.remote(root)
    return this.done(info, "applied", yes("⚡ Sent anyway, steered in."))
  }

  private done(info: Info, outcome: string, out: Outcome): Outcome {
    info.outcome = outcome
    return out
  }

  private async route(
    ch: Connector,
    m: Inbound,
    name: string,
    info: Info,
  ): Promise<Outcome> {
    const args = (m.command?.args ?? "").trim()
    if (name === "pick") return this.pick(ch, m, info)
    if (name === "reply") return this.reply(ch, m, info)
    info.root = m.sessionKey
    if ((ANYWHERE_COMMANDS as readonly string[]).includes(name))
      return this.anywhere(m, name, info)
    if (name === "help") return this.done(info, "applied", this.help(m))
    const inSession = m.sessionKey !== undefined
    if ((SESSION_COMMANDS as readonly string[]).includes(name)) {
      if (!inSession)
        return this.done(
          info,
          "scope",
          no(
            `/${name} acts on a session: send it in that session's topic. ` +
              "In General, /new, /sessions and /projects work; /help lists them.",
          ),
        )
      return this.session(ch, m, name, args, info)
    }
    if ((GENERAL_COMMANDS as readonly string[]).includes(name)) {
      if (inSession)
        return this.done(
          info,
          "scope",
          no(
            `/${name} works in the General topic or a private chat, not in a session's topic.`,
          ),
        )
      return this.general(ch, m, name, args, info)
    }
    return this.done(info, "unknown", no("Unknown command. /help lists them."))
  }

  private async anywhere(
    m: Inbound,
    name: string,
    info: Info,
  ): Promise<Outcome> {
    if (name === "afk") return this.done(info, "applied", yes(this.d.afk()))
    if (name === "version")
      return this.done(info, "applied", yes(await this.d.version()))
    if (name === "trace")
      return this.done(
        info,
        "applied",
        yes(this.d.trace(Number(m.command?.args) || 5).join("\n")),
      )
    if (name === "night") {
      const arg = (m.command?.args ?? "").trim().toLowerCase()
      if (arg === "end" || arg === "stop")
        return this.done(info, "applied", await this.d.endNight())
      return this.done(
        info,
        "applied",
        yes(
          this.d.night() +
            "\n/night end ends the plan. Only the Mac starts or changes one.",
        ),
      )
    }
    if (name === "digest") {
      const out = await this.d.digest()
      return this.done(info, out.ok ? "applied" : "disabled", out)
    }
    // resume
    if (m.sessionKey) {
      const blocked = await this.gate(m.sessionKey, info)
      if (blocked) return blocked
      return this.done(info, "applied", await this.d.resume(m.sessionKey))
    }
    const stuck = this.d.stuck()
    if (stuck.length === 0)
      return this.done(info, "applied", yes("Nothing is stuck."))
    return this.done(
      info,
      "applied",
      this.menu(
        "resume",
        "Wake which session?",
        stuck.map((s) => ({
          label: `${s.label} (${s.pending} waiting)`,
          value: s.id,
        })),
      ),
    )
  }

  private async applyUndo(root: string, info: Info): Promise<Outcome> {
    try {
      const reverted = await this.d.actions.undo(root)
      return this.done(
        info,
        reverted ? "applied" : "invalid",
        reverted ? yes("↩ Reverted the last turn.") : no("Nothing to undo."),
      )
    } catch (err) {
      if (err instanceof Refused)
        return this.done(info, "refused", no(err.message))
      throw err
    }
  }

  private help(m: Inbound): Outcome {
    if (m.sessionKey)
      return yes(
        [
          "In this session's topic:",
          "/model: pick the model for the next prompts",
          "/agent: pick the agent",
          "/variant (/effort): pick the model's effort variant",
          "/status: redraw and pin the status card",
          "/stop: stop the running turn",
          "/undo: revert the last turn (asks first)",
          "/resume: wake this session if it is stuck",
          "/afk: who counts as away (read only)",
          "/version: the plugin version installed and running",
          "/trace [n]: the last n updates and sends, with their path and outcome",
          "/night: the overnight plan; /night end ends it",
          "/steer <text>: inject a message into the running turn (or start with !)",
          "/compact: compact the session",
          "/rename <title>: rename the session",
          "/chat off: stop chatting with this session",
          "Chat is switched on in the TUI: /oob chat on.",
        ].join("\n"),
      )
    return yes(
      [
        "In General or a private chat:",
        "/new [project] [prompt]: start a session in a listed project",
        "/sessions: sessions that are mirrored here",
        "/projects: the projects /new can use",
        "/resume: wake a stuck session (lists them)",
        "/afk: who counts as away (read only)",
        "/version: the plugin version installed and running",
        "/trace [n]: the last n updates and sends, with their path and outcome",
        "/night: the overnight plan; /night end ends it",
        "Inside a session's topic: /model, /agent, /variant, /status, /stop, /steer, /compact, /rename, /chat off.",
      ].join("\n"),
    )
  }

  private async gate(root: string, info: Info): Promise<Outcome | undefined> {
    if (!this.d.chatEnabled(root))
      return this.done(
        info,
        "off",
        no("Chat is off for this session: run /oob chat on in the TUI."),
      )
    if (this.d.denied(await this.d.host.session(root)))
      return this.done(
        info,
        "denied",
        no("Chat is blocked for this session by chat.deny."),
      )
    return undefined
  }

  private menu(
    kind: Flow["kind"],
    title: string,
    choices: Array<{ label: string; value: string; current?: boolean }>,
    extra: Partial<Flow> = {},
  ): Outcome {
    const id = this.flow({
      kind,
      values: choices.map((c) => c.value),
      ...extra,
    })
    return { ok: true, text: title, menu: { id, choices } }
  }

  private flow(f: Omit<Flow, "exp">): string {
    const now = this.d.now()
    for (const [k, v] of this.flows) if (v.exp < now) this.flows.delete(k)
    while (this.flows.size >= MAX_FLOWS)
      this.flows.delete(this.flows.keys().next().value!)
    const id = randomBytes(3).toString("hex")
    this.flows.set(id, { ...f, exp: now + FLOW_TTL_MS })
    return id
  }

  private models(): Promise<ModelOption[]> {
    return this.d.actions.models()
  }

  /** A menu, or a refusal that still shows the menu when something was typed that is not in it. */
  private offer(info: Info, typed: string, out: Outcome): Outcome {
    return this.done(
      info,
      typed ? "invalid" : "applied",
      typed ? { ...out, ok: false } : out,
    )
  }

  private async session(
    ch: Connector,
    m: Inbound,
    name: string,
    args: string,
    info: Info,
  ): Promise<Outcome> {
    const root = m.sessionKey!
    info.root = root
    if (name === "chat") {
      if (args.toLowerCase() === "off")
        return this.done(info, "applied", await this.d.setChat(root, false))
      return this.done(
        info,
        "invalid",
        no(
          args.toLowerCase() === "on"
            ? "Chat is switched on in the TUI: /oob chat on."
            : "Usage: /chat off",
        ),
      )
    }
    if (name === "status") {
      await this.d.show(root)
      const ok = (await ch.refresh?.(root)) === true
      return this.done(
        info,
        ok ? "applied" : "invalid",
        ok
          ? yes("Status card refreshed.")
          : no("This session has no status card yet."),
      )
    }
    const blocked = await this.gate(root, info)
    if (blocked) return blocked
    const facts = await this.d.host.session(root)

    if (name === "stop") {
      const stopped = await this.d.actions.stop(root)
      return this.done(
        info,
        "applied",
        yes(stopped ? "⏹ Stopped the running turn." : "Nothing is running."),
      )
    }
    if (name === "undo") {
      if (this.d.host.busy(root))
        return this.done(
          info,
          "invalid",
          no("Stop the running turn first: /stop."),
        )
      return this.done(
        info,
        "applied",
        this.menu(
          "undo",
          "Revert the last turn of this session?",
          [
            { label: "Undo", value: "undo" },
            { label: "Cancel", value: "cancel" },
          ],
          { root },
        ),
      )
    }
    if (name === "steer") {
      if (!args) return this.done(info, "invalid", no("Usage: /steer <text>"))
      const busy = this.d.host.busy(root)
      await this.d.actions.prompt(root, args, "steer")
      this.d.remote(root)
      return this.done(
        info,
        busy ? "steered" : "sent",
        yes(busy ? "⚡ steered in" : "→ sent"),
      )
    }
    if (name === "compact") {
      await this.d.actions.compact(root)
      return this.done(info, "applied", yes("Compacting the session…"))
    }
    if (name === "rename") {
      if (!args || args.length > MAX_TITLE)
        return this.done(
          info,
          "invalid",
          no(`Usage: /rename <title> (up to ${MAX_TITLE} characters)`),
        )
      await this.d.actions.rename(root, args)
      return this.done(info, "applied", yes("Renamed."))
    }
    if (name === "agent") {
      const agents = await this.d.host.agents().catch(() => [] as string[])
      if (agents.length === 0)
        return this.done(
          info,
          "invalid",
          no("OpenCode lists no agents to choose from."),
        )
      if (args && agents.includes(args))
        return this.applyAgent(root, args, info)
      return this.offer(
        info,
        args,
        this.menu(
          "agent",
          args
            ? "Not an agent I can use. Pick one:"
            : "Agent for this session:",
          agents.map((a) => ({
            label: a,
            value: a,
            current: a === facts?.agent,
          })),
          { root },
        ),
      )
    }
    if (name === "model") {
      const list = await this.models()
      if (list.length === 0)
        return this.done(
          info,
          "invalid",
          no("OpenCode lists no models to choose from."),
        )
      const now = facts?.modelRef
        ? `${facts.modelRef.providerID}/${facts.modelRef.id}`
        : undefined
      const hit = args ? list.find((x) => x.ref === args) : undefined
      if (hit) return this.applyModel(root, hit, undefined, info)
      return this.offer(
        info,
        args,
        this.menu(
          "model",
          args
            ? "Not an allowed model. Pick one:"
            : "Model for the next prompts:",
          list.map((x) => ({
            label: x.name,
            value: x.ref,
            current: x.ref === now,
          })),
          { root },
        ),
      )
    }
    // variant
    const ref = facts?.modelRef
    const model = ref
      ? (await this.d.host.models().catch(() => [] as ModelOption[])).find(
          (x) => x.ref === `${ref.providerID}/${ref.id}`,
        )
      : undefined
    if (!ref || !model || model.variants.length === 0)
      return this.done(info, "invalid", no("This model has no variants."))
    const options = [DEFAULT, ...model.variants]
    if (args && options.includes(args))
      return this.applyModel(
        root,
        model,
        args === DEFAULT ? undefined : args,
        info,
      )
    return this.offer(
      info,
      args,
      this.menu(
        "variant",
        args
          ? `Not a variant of ${model.name}. Pick one:`
          : `Variant of ${model.name}:`,
        options.map((v) => ({
          label: v,
          value: v,
          current: (ref.variant ?? DEFAULT) === v,
        })),
        { root },
      ),
    )
  }

  private async applyAgent(
    root: string,
    agent: string,
    info: Info,
  ): Promise<Outcome> {
    await this.d.actions.switchAgent(root, agent)
    return this.done(
      info,
      "applied",
      yes(`Agent: ${agent}. It applies to the next prompts.`),
    )
  }

  private async applyModel(
    root: string,
    model: ModelOption,
    variant: string | undefined,
    info: Info,
  ): Promise<Outcome> {
    await this.d.actions.switchModel(root, { ...parseRef(model.ref), variant })
    return this.done(
      info,
      "applied",
      yes(
        `Model: ${model.name}${variant ? ` (${variant})` : ""}. It applies to the next prompts.`,
      ),
    )
  }

  private async general(
    ch: Connector,
    m: Inbound,
    name: string,
    args: string,
    info: Info,
  ): Promise<Outcome> {
    const projects = this.d.cfg.chat.projects
    const names = Object.keys(projects)
    if (name === "sessions") {
      const list = await this.d.sessions()
      return this.done(
        info,
        "applied",
        yes(
          list.length
            ? list
                .slice(0, 20)
                .map((s) => `• ${s.label} {topic:${s.id}}`)
                .join("\n")
            : "No session is mirrored here right now.",
        ),
      )
    }
    if (names.length === 0)
      return this.done(
        info,
        "off",
        no(
          "Starting sessions from a chat is off: list projects under chat.projects in the config.",
        ),
      )
    if (name === "projects")
      return this.done(
        info,
        "applied",
        yes(
          names
            .map((n) => {
              const p = projects[n]
              const bits = [basename(p.directory), p.agent, p.model].filter(
                Boolean,
              )
              return `• ${n} (${bits.join(" · ")})`
            })
            .join("\n"),
        ),
      )
    // /new
    const parsed = /^(\S+)\s*([\s\S]*)$/.exec(args)
    if (!parsed)
      return this.done(
        info,
        "applied",
        this.menu(
          "project",
          "Start a session in which project?",
          names.map((n) => ({ label: n, value: n })),
        ),
      )
    const [, project, prompt] = parsed
    if (!Object.hasOwn(projects, project))
      return this.done(
        info,
        "invalid",
        no(`No project "${project}". The projects are: ${names.join(", ")}.`),
      )
    if (prompt.trim())
      return this.create(ch, { project, text: prompt.trim() }, info)
    return this.chooseAgent(project, info)
  }

  private async chooseAgent(project: string, info: Info): Promise<Outcome> {
    const agents = await this.d.host.agents().catch(() => [] as string[])
    const own = this.d.cfg.chat.projects[project].agent ?? "OpenCode's own"
    return this.done(
      info,
      "applied",
      this.menu(
        "new-agent",
        `Agent for ${project}?`,
        [
          { label: `${DEFAULT} (${own})`, value: DEFAULT },
          ...agents.map((a) => ({ label: a, value: a })),
        ],
        { project },
      ),
    )
  }

  private async pick(ch: Connector, m: Inbound, info: Info): Promise<Outcome> {
    const f = m.token ? this.flows.get(m.token) : undefined
    const value = m.command?.args ?? ""
    if (!f || f.exp < this.d.now())
      return this.done(
        info,
        "invalid",
        no("That menu expired: send the command again."),
      )
    // One of what was offered, nothing else.
    if (!f.values.includes(value))
      return this.done(info, "invalid", no("That is not one of the choices."))
    this.flows.delete(m.token!)

    if (f.root) {
      info.root = f.root
      const blocked = await this.gate(f.root, info)
      if (blocked) return blocked
      if (f.kind === "held") return this.applyHeld(f, value, info)
      if (f.kind === "undo")
        return value === "undo"
          ? this.applyUndo(f.root, info)
          : this.done(info, "cancelled", yes("Cancelled."))
      if (f.kind === "agent") return this.applyAgent(f.root, value, info)
      if (f.kind === "model") {
        const hit = (await this.models()).find((x) => x.ref === value)
        return hit
          ? this.applyModel(f.root, hit, undefined, info)
          : this.done(info, "invalid", no("That model is not available."))
      }
      const ref = (await this.d.host.session(f.root))?.modelRef
      const hit = ref
        ? (await this.d.host.models()).find(
            (x) => x.ref === `${ref.providerID}/${ref.id}`,
          )
        : undefined
      return hit
        ? this.applyModel(
            f.root,
            hit,
            value === DEFAULT ? undefined : value,
            info,
          )
        : this.done(info, "invalid", no("This model has no variants."))
    }

    if (f.kind === "resume") {
      const blocked = await this.gate(value, info)
      if (blocked) return blocked
      return this.done(info, "applied", await this.d.resume(value))
    }
    if (f.kind === "project") return this.chooseAgent(value, info)
    if (f.kind === "new-agent") {
      const own = this.d.cfg.chat.projects[f.project!].model ?? "OpenCode's own"
      return this.done(
        info,
        "applied",
        this.menu(
          "new-model",
          `Model for ${f.project}?`,
          [
            { label: `${DEFAULT} (${own})`, value: DEFAULT },
            ...(await this.models()).map((x) => ({
              label: x.name,
              value: x.ref,
            })),
          ],
          { project: f.project, agent: value === DEFAULT ? undefined : value },
        ),
      )
    }
    // new-model: ask for the prompt.
    const id = this.flow({
      kind: "prompt",
      values: [],
      project: f.project,
      agent: f.agent,
      model: value === DEFAULT ? undefined : value,
    })
    return this.done(info, "applied", {
      ok: true,
      text: `Reply to this message with the prompt for ${f.project}.`,
      ask: { id },
    })
  }

  private async reply(ch: Connector, m: Inbound, info: Info): Promise<Outcome> {
    const f = m.token ? this.flows.get(m.token) : undefined
    const text = (m.command?.args ?? "").trim()
    if (!f || f.kind !== "prompt" || f.exp < this.d.now())
      return this.done(
        info,
        "invalid",
        no("That question expired: send /new again."),
      )
    if (!text)
      return this.done(
        info,
        "invalid",
        no("The prompt is empty: reply with some text."),
      )
    this.flows.delete(m.token!)
    return this.create(
      ch,
      { project: f.project!, agent: f.agent, model: f.model, text },
      info,
    )
  }

  /** Starts a session in a listed project, routed here with chat on, and sends it the prompt. */
  private async create(
    ch: Connector,
    o: { project: string; agent?: string; model?: string; text: string },
    info: Info,
  ): Promise<Outcome> {
    const span = this.d.tel.begin("oob.session.create", {
      attrs: { "connector.type": ch.type },
    })
    const end = (outcome: string, out: Outcome) => {
      span.end({ outcome }, out.ok ? undefined : outcome)
      log("session_create", { outcome, project: o.project })
      return this.done(info, outcome, out)
    }
    const r = await this.d.actions.create(o, (id) => this.d.startChat(id, ch))
    if (!r.ok) return end(r.outcome, no(r.text))
    const id = r.id!
    this.d.remote(id)
    await this.d.show(id, true)
    const agent = o.agent ?? this.d.cfg.chat.projects[o.project].agent
    return end("applied", {
      ok: true,
      text: `🆕 Started ${o.project} · ${agent ?? "default agent"} → {topic:${id}}`,
    })
  }
}

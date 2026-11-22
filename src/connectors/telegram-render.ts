/**
 * Telegram message markup. Everything is built from plain parts that are
 * truncated first and escaped second, then wrapped in tags, so a tag is never
 * cut and no text is ever read as markup. A message is at most 4096 characters.
 */
import type { ApprovalView, Settled } from "../approvals/types.ts"
import { filterSecrets } from "../filter.ts"
import { clock, truncate } from "../util.ts"
import { PAGE, reviewing, type Stepper } from "../stepper.ts"
import { header, MAX_FILES, MAX_SUMMARY } from "../turncard.ts"
import type {
  Card,
  CardQuestion,
  Push,
  SessionState,
  TurnCard,
} from "./types.ts"

export const LIMIT = 4096
// Margin under the limit: entity characters count once after parsing, but a count of raw HTML is the safe side.
const BUDGET = 4000

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Escaped `text` that is at most `max` characters long, ending in "…" when cut. */
export function fit(text: string, max: number): string {
  if (esc(text).length <= max) return esc(text)
  // Escaping only lengthens, so more than `max` characters never fit.
  let t = text.slice(0, max)
  while (t.length > 0 && esc(t).length + 1 > max)
    t = t.slice(
      0,
      Math.max(0, Math.min(t.length - 1, Math.floor(t.length * 0.9))),
    )
  return `${esc(t.trimEnd())}…`
}

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
export const keycap = (n: number) => KEYCAPS[n - 1] ?? `${n}.`

/** "(Recommended)" becomes a star after the label. */
export function starred(label: string): string {
  const plain = label.replace(/\s*\(recommended\)\s*/i, " ").trim()
  return plain === label.trim() ? label : `${plain} ⭐`
}

const clean = (s: string) => filterSecrets(s)

type Stage = { text: number; label: number; detail: number; options: number }

const STAGES: Stage[] = [
  { text: 1500, label: 120, detail: 60, options: 30 },
  { text: 700, label: 60, detail: 40, options: 20 },
  { text: 300, label: 40, detail: 0, options: 12 },
  { text: 150, label: 24, detail: 0, options: 0 },
]

function questionBlock(
  q: CardQuestion,
  n: number,
  of: number,
  st: Stage,
): string[] {
  const out: string[] = []
  const head = of > 1 ? `${n}) ${q.header || q.text}` : q.text
  out.push(`<b>${fit(clean(head), st.text)}</b>`)
  if (of > 1 && q.header && q.text && q.text !== q.header)
    out.push(fit(clean(q.text), st.text))
  const shown = q.options.slice(0, st.options)
  if (shown.length) out.push("")
  shown.forEach((o, i) => {
    out.push(
      `${keycap(i + 1)} <b>${fit(clean(starred(o.label)), st.label)}</b>`,
    )
    if (o.detail && st.detail)
      out.push(`      <i>${fit(clean(o.detail), st.detail)}</i>`)
  })
  if (q.options.length > shown.length)
    out.push(`      <i>… and ${q.options.length - shown.length} more</i>`)
  return out
}

export type RenderOptions = {
  /** The message goes into the session's own topic, which already names it. */
  inTopic?: boolean
  /** Muted last line of a question. */
  footer?: string
}

function lines(card: Card, o: RenderOptions, st: Stage): string[] {
  const where = (s?: string) =>
    s && !o.inTopic ? [`📌 ${fit(clean(s), 200)}`] : []
  switch (card.kind) {
    case "question": {
      const out = [
        `❓ <b>${fit(clean(card.agent), 60)}</b> asks · <i>${fit(clean(card.project), 60)}</i>`,
        ...where(card.session),
      ]
      card.questions.forEach((q, i) => {
        out.push("", ...questionBlock(q, i + 1, card.questions.length, st))
      })
      const foot = o.footer ?? card.note
      if (foot) out.push("", `<i>${fit(foot, 200)}</i>`)
      return out
    }
    case "permission":
      return [
        `🔐 <b>${fit(clean(card.agent), 60)}</b> needs permission · <i>${fit(clean(card.project), 60)}</i>`,
        ...where(card.session),
        "",
        `<pre>${fit(clean(card.detail), st.text)}</pre>`,
        "",
        `<i>${o.footer ?? "Answer in the OpenCode TUI. Permissions are never applied remotely."}</i>`,
      ]
    case "finished":
    case "failed":
      return [
        `${card.kind === "failed" ? "❌" : "✅"} <b>${card.kind === "failed" ? "Failed" : "Finished"}</b> · <i>${fit(clean(card.project), 60)}</i>`,
        ...where(card.session),
        ...(card.duration ? [`⏱ ${fit(card.duration, 40)}`] : []),
      ]
    case "closed": {
      const where =
        card.origin === "mac"
          ? card.reconciled
            ? "Already answered at the Mac"
            : "Answered at the Mac"
          : card.origin === "telegram"
            ? "Answered in Telegram"
            : undefined
      const head =
        card.outcome === "cancelled"
          ? "⚪ <b>Cancelled</b>"
          : where
            ? `✅ <b>${where}</b>${card.answer ? `: ${fit(clean(card.answer), 300)}` : ""}`
            : `✅ <b>Answered</b>${card.answer ? ` · ${fit(clean(card.answer), 300)}` : ""}`
      return [
        head,
        where
          ? `<i>${fit(card.time, 10)}</i>`
          : `<i>via ${fit(card.via, 40)} · ${fit(card.time, 10)}</i>`,
        ...(card.quote
          ? ["", `<blockquote>${fit(clean(card.quote), st.text)}</blockquote>`]
          : []),
      ]
    }
    case "notice":
      return [`⚠️ ${fit(clean(card.text), st.text)}`]
  }
}

/** The card as HTML, at most 4096 characters, shrinking the body as needed. */
export function renderCard(card: Card, o: RenderOptions = {}): string {
  for (const st of STAGES) {
    const html = lines(card, o, st).join("\n")
    if (html.length <= BUDGET) return html
  }
  // Pathological input (hundreds of questions): the header and a pointer, never a cut tag.
  const last = STAGES[STAGES.length - 1]
  const head = lines(card, o, { ...last, text: 40, options: 0 }).slice(0, 3)
  return [...head, "", "<i>Too long to show here: open OpenCode.</i>"].join(
    "\n",
  )
}

/** A push without a card: its title in bold, then its message. */
export function renderPlain(push: Push): string {
  const title = push.title ? `<b>${fit(clean(push.title), 300)}</b>\n` : ""
  return `${title}${fit(clean(push.message), BUDGET - title.length)}`
}

export const renderPush = (push: Push, o: RenderOptions = {}) =>
  push.card ? renderCard(push.card, o) : renderPlain(push)

/**
 * How a session is watched and whether chat is on, short enough to lead the
 * card: the pinned-message bar shows only its first line.
 */
export function watchHead(s: SessionState): string {
  const w = s.watch
  const watch = !w
    ? undefined
    : w.mode === "on"
      ? w.channel === "all"
        ? "👁 on"
        : `👁 on·${w.channel}`
      : w.mode === "auto"
        ? "⏱ auto"
        : "🔕 off"
  const chat = w || s.chat ? (s.chat ? "💬 on" : "💬 off") : undefined
  return [watch, chat].filter(Boolean).join(" · ")
}

const watchLine = (w: NonNullable<SessionState["watch"]>): string =>
  w.mode === "on"
    ? w.channel === "all"
      ? "👁 <b>Watched</b>: on"
      : `👁 <b>Watched</b>: on via ${esc(w.channel)}`
    : w.mode === "auto"
      ? `⏱ <b>Watched</b>: auto, after ${w.minutes} min away`
      : "🔕 <b>Not watched</b>"

/** The pinned status card of a session topic. `icon` is the topic's emoji, shown with the project. */
export function renderStatus(s: SessionState, icon?: string): string {
  const at = clock(s.at)
  const state =
    s.state === "working"
      ? "🟢 <b>Working</b>"
      : s.state === "idle"
        ? `💤 <b>Idle</b> ${at}`
        : `❌ <b>Failed</b> ${at}`
  const head = watchHead(s)
  const model = s.model && s.variant ? `${s.model} (${s.variant})` : s.model
  const agent = [s.agent, model].filter(Boolean).join(" · ")
  return [
    head ? `${head} — ${state}` : state,
    ...(s.title ? [`📌 ${fit(clean(s.title), 200)}`] : []),
    ...(agent ? [`🤖 ${fit(clean(agent), 120)}`] : []),
    `📁 ${fit(clean(s.project), 80)}${icon ? ` ${icon}` : ""}`,
    `🆔 <code>${esc(s.id.slice(-6))}</code>`,
    ...(s.watch ? [watchLine(s.watch)] : []),
    `🕐 ${at}`,
  ].join("\n")
}

/** A turn card: the header, and the summary and files in a block Telegram shows collapsed. */
export function renderTurnCard(card: TurnCard): string {
  const out = [`<b>${esc(header(card))}</b>`]
  const body: string[] = []
  if (card.summary) body.push(fit(card.summary, MAX_SUMMARY + 50))
  const shown = card.files.slice(0, MAX_FILES)
  if (shown.length)
    body.push(
      shown.map((f) => `• ${fit(f, 120)}`).join("\n") +
        (card.files.length > shown.length
          ? `\n+${card.files.length - shown.length} more`
          : ""),
    )
  if (body.length)
    out.push(`<blockquote expandable>${body.join("\n\n")}</blockquote>`)
  return out.join("\n")
}

type Key = { text: string; callback_data: string }

/** The message of a form stepper: the field (or the review) and its buttons. */
export function renderStepper(s: Stepper): { text: string; rows: Key[][] } {
  const n = s.questions.length
  const key = (text: string, act: string): Key => ({
    text: truncate(text, 40),
    callback_data: "s:" + s.id + ":" + act,
  })
  if (reviewing(s)) {
    const lines = s.questions.map(
      (q, i) =>
        `${i + 1}. ${fit(q.header || q.text, 60)}: <b>${fit(s.chosen[i].join(", "), 80)}</b>`,
    )
    return {
      text: [`<b>${esc(s.head)}</b>`, "Review your answers", ...lines].join(
        "\n",
      ),
      rows: [[key("✅ Submit", "ok"), key("Edit", "e")], [key("Cancel", "x")]],
    }
  }
  const q = s.questions[s.at]
  const pages = Math.ceil(q.options.length / PAGE)
  const from = s.page * PAGE
  const shown = q.options.slice(from, from + PAGE)
  const ticked = new Set(s.chosen[s.at])
  const rows: Key[][] = shown.map((label, i) => [
    key(
      `${q.multiple && ticked.has(label) ? "✓ " : ""}${keycap(from + i + 1)} ${starred(label)}`,
      (q.multiple ? "t" : "o") + (from + i + 1),
    ),
  ])
  if (pages > 1) {
    const nav: Key[] = []
    if (s.page > 0) nav.push(key("‹ Prev", "p" + (s.page - 1)))
    if (s.page < pages - 1) nav.push(key("Next ›", "p" + (s.page + 1)))
    rows.push(nav)
  }
  const tail: Key[] = []
  if (s.at > 0) tail.push(key("‹ Back", "b"))
  if (q.custom) tail.push(key("✏️ Type", "w"))
  if (q.multiple) tail.push(key("Done", "d"))
  if (tail.length) rows.push(tail)
  const text = [
    `<b>${esc(s.head)}</b>`,
    `<i>${s.at + 1}/${n}${q.header ? " · " + esc(q.header) : ""}</i>`,
    fit(q.text, 600),
    ...(q.multiple ? ["Tick options, then Done."] : []),
    ...(pages > 1 ? [`Page ${s.page + 1}/${pages}`] : []),
  ].join("\n")
  return { text, rows }
}

const ENDED: Record<string, string> = {
  timeout: "⌛ Expired",
  bridge_restart: "⌛ Expired: the bridge restarted",
  withdrawn: "↩ Withdrawn by the caller",
  present: "↩ Withdrawn: you are at the Mac",
  cooldown: "🚫 Denied: asked again too soon",
  bad_code: "🚫 Denied: three wrong codes",
}

/** The approval message: who asks, for what, and then either the time left or how it ended. */
export function renderApproval(
  v: ApprovalView,
  s?: Settled,
  now = Date.now(),
): string {
  const who = [
    v.requester.agent,
    v.requester.session_id,
    v.requester.tool && `via ${v.requester.tool}`,
  ]
    .filter(Boolean)
    .join(" · ")
  const end = s
    ? s.decision === "approve"
      ? `✅ Approved · L${s.level}`
      : s.decision === "deny"
        ? (ENDED[s.reason ?? ""] ?? `❌ Denied · L${s.level}`)
        : (ENDED[s.reason ?? ""] ?? "⌛ Expired")
    : `Answer within ${Math.max(1, Math.round((v.expiresAt - now) / 60_000))} min`
  const lines: Array<string | undefined> = [
    `🔐 <b>Approval #${esc(v.short)}</b> · L${v.level}`,
    `<b>${esc(v.caller)}</b> asks for <code>${esc(v.action_class)}</code>`,
    who ? `Session: ${fit(who, 300)}` : undefined,
    `What: ${fit(v.scope, 600)}`,
    v.reason ? `Why: ${fit(v.reason, 400)}` : undefined,
    "",
    v.level >= 2 && !s ? "Tap Approve, then type the 6-digit code." : undefined,
    end,
  ]
  return lines.filter((l) => l !== undefined).join("\n")
}

export const renderApprovalCode = (v: ApprovalView): string => {
  const what = `#${esc(v.short)}${v.scope ? ` (${fit(v.scope, 120)})` : ""}`
  const app = v.factors?.some((f) => f !== "totp")
  if (!app) return `🔑 Type the 6-digit code for ${what}`
  return v.factors?.includes("totp")
    ? `🔐 Verify ${what}: open the app, or type the 6-digit code`
    : `🔐 Verify ${what}: open the app`
}

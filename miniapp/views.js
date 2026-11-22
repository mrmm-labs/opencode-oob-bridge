// Drawing. Every string from the API goes in as text, never as markup.
import {
  aboutLine,
  ago,
  avatarOf,
  diffClass,
  groups,
  hasWords,
  hay,
  hhmm,
  isStale,
  nameOf,
  permissionChoices,
  refusalText,
  short,
  stateLabel,
  subtitle,
} from "./format.js"
import * as F from "./form.js"
import { parse } from "./md.js"

export function h(tag, props, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === "class") el.className = v
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
    else if (k === "value") el.value = v
    else if (k === "style" && typeof v === "object")
      for (const [name, x] of Object.entries(v))
        el.style.setProperty(name, String(x))
    else el.setAttribute(k, v === true ? "" : v)
  }
  for (const kid of kids.flat(Infinity))
    if (kid !== null && kid !== undefined && kid !== false) el.append(kid)
  return el
}

/** What the person has typed and not sent: it outlives a redraw. */
export const drafts = {}

const field = (name, props, tag = "input") =>
  h(tag, {
    ...props,
    value: drafts[name] ?? "",
    oninput: (e) => (drafts[name] = e.target.value),
  })

const button = (label, onclick, { kind = "", disabled = false, title } = {}) =>
  h(
    "button",
    { type: "button", class: "btn " + kind, onclick, disabled, title },
    label,
  )

const pill = (key, text) => h("span", { class: "pill " + key }, text)

const empty = (text) => h("p", { class: "hint pad" }, text)

/** A field the API could not fill says why. */
const unavailable = (f) =>
  h("p", { class: "hint" }, "Unavailable: " + f.unavailable)

const SVG = "http://www.w3.org/2000/svg"

const ICONS = {
  list: "M4 6h16M4 12h16M4 18h16",
  new: "M12 5v14M5 12h14",
  night: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01",
  chev: "M9 6l6 6-6 6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  send: "M12 19V5M5 12l7-7 7 7",
  plus: "M12 5v14M5 12h14",
}

/** A line icon, drawn from a path: the shapes are fixed here and no text goes into them. */
function icon(name, cls = "ico") {
  const svg = document.createElementNS(SVG, "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("class", cls)
  svg.setAttribute("aria-hidden", "true")
  const path = document.createElementNS(SVG, "path")
  path.setAttribute("d", ICONS[name])
  svg.append(path)
  return svg
}

const avatar = (s, extra) => {
  const a = avatarOf(s)
  return h(
    "span",
    { class: "avatar", style: { "--hue": a.hue }, "aria-hidden": "true" },
    a.letter,
    extra,
  )
}

const skeleton = () =>
  h(
    "ul",
    { class: "group", "aria-busy": "true", "aria-label": "Loading" },
    [0, 1, 2, 3].map(() =>
      h(
        "li",
        { class: "sk-row" },
        h("span", { class: "avatar sk" }),
        h(
          "span",
          { class: "grow" },
          h("span", { class: "sk-line" }),
          h("span", { class: "sk-line short" }),
        ),
      ),
    ),
  )

const spans = (nodes) =>
  nodes.map((n) =>
    n.t === "text"
      ? n.v
      : n.t === "ic"
        ? h("code", null, n.v)
        : n.t === "b"
          ? h("strong", null, spans(n.c))
          : n.t === "i"
            ? h("em", null, spans(n.c))
            : h(
                "a",
                { href: n.href, target: "_blank", rel: "noopener noreferrer" },
                spans(n.c),
              ),
  )

/** The elements of a message: its markdown, built from the parsed blocks, never from markup. */
const markdown = (text) =>
  parse(String(text ?? "").slice(0, 20_000)).map((b) => {
    if (b.t === "p") return h("p", null, spans(b.c))
    if (b.t === "h") return h("h4", null, spans(b.c))
    if (b.t === "ul" || b.t === "ol")
      return h(
        b.t,
        null,
        b.items.map((i) => h("li", null, spans(i))),
      )
    if (b.t === "pre") return h("pre", { class: "code" }, h("code", null, b.v))
    return h(
      "div",
      { class: "tbl" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            b.head.map((c) => h("th", null, spans(c))),
          ),
        ),
        h(
          "tbody",
          null,
          b.rows.map((r) =>
            h(
              "tr",
              null,
              r.map((c) => h("td", null, spans(c))),
            ),
          ),
        ),
      ),
    )
  })

export function render(state, ctl, now, ui = {}) {
  const { phase } = state
  const ready = phase === "ready"
  const body = ready
    ? screen(state, ctl, now, ui)
    : [
        hero(),
        phase === "loading" ? skeleton() : notice(phase, ctl, state.reason),
      ]
  const route = state.route.name
  return h(
    "div",
    { class: "app" },
    ready && state.conn !== "live" && banner(state),
    ready && route !== "list" && route !== "session" && header(state),
    h("main", { class: "main" }, body),
    ready && tabs(state, ctl),
    state.toast &&
      now - state.toast.at < 4000 &&
      h(
        "div",
        { class: "toast " + (state.toast.ok ? "ok" : "bad"), role: "status" },
        state.toast.text,
      ),
    state.confirm && !ui.nativeConfirm && confirmSheet(state, ctl),
  )
}

const TITLES = {
  new: "New session",
  night: "Overnight",
  info: "Info",
  approval: "Approval",
  question: "Question",
  enroll: "Set up this phone",
}

const header = (state) =>
  h("header", { class: "top" }, h("h1", null, TITLES[state.route.name] ?? ""))

const banner = (state) =>
  h(
    "div",
    {
      class: "offline",
      role: "status",
      title: "What you see may be out of date, and actions are off.",
    },
    (state.conn === "connecting" ? "Connecting…" : "Offline") +
      (state.updatedAt ? " · updated " + hhmm(state.updatedAt) : ""),
  )

function notice(phase, ctl, reason) {
  const text =
    refusalText(reason) ??
    {
      nolaunch:
        "Open this app from Telegram: it has no way to know who you are here.",
      expired:
        "This view has expired. Close it and open the app again from Telegram.",
      forbidden:
        "Not authorised. This app is for the person who set up the bot.",
      offline: "The Mac cannot be reached. Check that it is awake and online.",
    }[phase]
  return h(
    "section",
    { class: "card center" },
    h("p", null, text),
    phase === "offline" &&
      button("Retry", () => void ctl.boot(), { kind: "primary" }),
  )
}

function tabs(state, ctl) {
  const at = state.route.name === "session" ? "list" : state.route.name
  const tab = (name, label) =>
    h(
      "button",
      {
        type: "button",
        class: "tab" + (at === name ? " on" : ""),
        "aria-current": at === name ? "page" : undefined,
        onclick: () => void ctl.go(name),
      },
      icon(name),
      label,
    )
  return h(
    "nav",
    { class: "tabs" },
    tab("list", "Sessions"),
    tab("new", "New"),
    tab("night", "Overnight"),
    tab("info", "Info"),
  )
}

function confirmSheet(state, ctl) {
  return h(
    "div",
    { class: "scrim" },
    h(
      "div",
      { class: "sheet", role: "alertdialog", "aria-label": state.confirm.text },
      h("p", null, state.confirm.text),
      h(
        "div",
        { class: "row" },
        button("Cancel", () => ctl.cancel()),
        button("Yes", () => void ctl.confirmed(), { kind: "danger" }),
      ),
    ),
  )
}

function screen(state, ctl, now, ui) {
  switch (state.route.name) {
    case "session":
      return session(state, ctl, now, ui)
    case "new":
      return newSession(state, ctl)
    case "night":
      return night(state, ctl)
    case "info":
      return info(state, ctl, now)
    case "approval":
      return approval(state, ctl)
    case "question":
      return questionScreen(state, ctl)
    case "enroll":
      return enroll(state, ctl)
    default:
      return list(state, ctl, now)
  }
}

const APP_INFO = "https://github.com/mrmm-labs/opencode-oob-bridge#readme"

const hero = () =>
  h(
    "div",
    { class: "hero" },
    h("div", { class: "hero-av", "aria-hidden": "true" }, ">_"),
    h("h2", { class: "hero-name" }, "OpenCode"),
    h(
      "p",
      { class: "hero-sub" },
      "Watch and steer your coding sessions from here. ",
      h(
        "a",
        { href: APP_INFO, target: "_blank", rel: "noopener noreferrer" },
        "Learn more ›",
      ),
    ),
  )

/** Hides the rows the search does not match, and a section left with none; the rows stay in place. */
function narrow(root) {
  const q = drafts.search ?? ""
  let any = false
  for (const sect of root.querySelectorAll(".sect")) {
    let n = 0
    for (const li of sect.querySelectorAll("li[data-q]")) {
      const hit = hasWords(li.dataset.q, q)
      li.hidden = !hit
      if (hit) n++
    }
    sect.hidden = n === 0
    any ||= n > 0
  }
  const none = root.querySelector(".none")
  if (none) none.hidden = any || q.trim() === ""
}

function row(s, ctl, now) {
  const st = stateLabel(s)
  return h(
    "li",
    { "data-q": hay(s) },
    h(
      "button",
      {
        type: "button",
        class: "row-btn",
        "data-id": s.id,
        onclick: () => void ctl.open(s.id),
      },
      avatar(
        s,
        h("span", {
          class: "dot " + st.key,
          role: "img",
          "aria-label": st.text,
        }),
      ),
      h(
        "span",
        { class: "grow" },
        h(
          "span",
          { class: "line" },
          h("span", { class: "title" }, nameOf(s)),
          h("span", { class: "when" }, short(s.lastActivity, now)),
        ),
        h(
          "span",
          { class: "line" },
          h(
            "span",
            { class: "sub" },
            s.blocked
              ? "Blocked by chat.deny"
              : [subtitle(s), s.watch?.mode === "off" && "not watched"]
                  .filter(Boolean)
                  .join(" · ") || st.text,
          ),
          s.pending > 0 &&
            h(
              "span",
              { class: "badge", "aria-label": s.pending + " waiting on you" },
              String(s.pending),
            ),
        ),
      ),
      icon("chev", "chev"),
    ),
  )
}

function list(state, ctl, now) {
  const root = h(
    "section",
    { class: "home" },
    hero(),
    h(
      "label",
      { class: "search" },
      icon("search"),
      h("input", {
        type: "search",
        placeholder: "Search sessions",
        "aria-label": "Search sessions",
        autocomplete: "off",
        value: drafts.search ?? "",
        oninput: (e) => {
          drafts.search = e.target.value
          narrow(root)
        },
      }),
    ),
    h(
      "ul",
      { class: "group" },
      h(
        "li",
        null,
        h(
          "button",
          {
            type: "button",
            class: "row-btn new",
            onclick: () => void ctl.go("new"),
          },
          h(
            "span",
            { class: "avatar plus", "aria-hidden": "true" },
            icon("plus"),
          ),
          h(
            "span",
            { class: "grow" },
            h("span", { class: "title" }, "New session"),
          ),
          icon("chev", "chev"),
        ),
      ),
    ),
    !state.loaded
      ? skeleton()
      : state.sessions.length === 0
        ? empty("No sessions yet. Start one with New session.")
        : groups(state.sessions).map((g) =>
            h(
              "div",
              { class: "sect" },
              h("h3", { class: "sect-title" }, g.title),
              h(
                "ul",
                { class: "group" },
                g.items.map((s) => row(s, ctl, now)),
              ),
            ),
          ),
    h("p", { class: "hint pad none", hidden: true }, "No session matches."),
    state.total > state.sessions.length &&
      h(
        "p",
        { class: "hint pad" },
        state.sessions.length + " of " + state.total + " shown",
      ),
  )
  narrow(root)
  return root
}

const available = (meta, name) => meta?.actions?.find((a) => a.name === name)

function session(state, ctl, now, ui = {}) {
  const d = state.detail
  const back =
    !ui.nativeBack &&
    button("‹ Sessions", () => void ctl.go("list"), { kind: "link" })
  if (!d) return h("section", null, back, skeleton())
  const st = stateLabel(d)
  const can = ctl.canAct()
  const off = (name) => {
    const a = available(state.meta, name)
    return a && !a.available ? a : undefined
  }
  const act = (name, label, kind) =>
    button(
      label,
      () => (name === "compact" ? void ctl.act(name) : ctl.ask(name)),
      {
        kind,
        disabled: !can || !!off(name) || !!d.blocked,
        title: off(name)?.reason,
      },
    )
  const more = "more:" + d.id
  const quick = [
    d.state === "working" && act("stop", "Stop", "danger"),
    (d.state === "suspended" || d.stuck) && act("resume", "Resume", "primary"),
  ].filter(Boolean)
  return h(
    "section",
    { class: "detail" },
    back,
    h(
      "div",
      { class: "card head" },
      h(
        "div",
        { class: "head-row" },
        avatar(d),
        h(
          "div",
          { class: "grow" },
          h("h2", { class: "head-title" }, nameOf(d)),
          h(
            "p",
            { class: "sub" },
            [d.model, d.variant, d.agent].filter(Boolean).join(" · ") ||
              subtitle(d),
          ),
          h("div", { class: "tags" }, pill(st.key, st.text)),
        ),
      ),
      d.blocked &&
        h(
          "p",
          { class: "hint" },
          "Blocked by chat.deny (" +
            d.blocked +
            "): nothing here can be changed.",
        ),
      quick.length > 0 && h("div", { class: "row wrap" }, quick),
      h(
        "details",
        {
          class: "more",
          open: drafts[more] ? true : undefined,
          ontoggle: (e) => (drafts[more] = e.target.open),
        },
        h("summary", null, "Controls"),
        watching(state, ctl, d, can),
        h(
          "div",
          { class: "row wrap" },
          act("undo", "Undo"),
          act("compact", "Compact"),
          button("Continue", () => void ctl.send("continue"), {
            disabled: !can || !!d.blocked,
          }),
        ),
        pickers(state, ctl, d, can),
      ),
    ),
    h(
      "div",
      { class: "pending" },
      d.questions.map((q) => question(state, ctl, d, q, can)),
      d.permissions.map((p) => permission(state, ctl, p, can)),
    ),
    conversation(state, ctl, d, now),
    changes(state, ctl, d),
    todos(d),
    composer(ctl, d, can),
  )
}

/** Whether the bridge mirrors this session to the chat, and whether the chat can talk to it. */
function watching(state, ctl, d, can) {
  const dead = (name) => {
    const a = available(state.meta, name)
    return !can || !!d.blocked || (a && !a.available)
  }
  return h(
    "div",
    { class: "ctl" },
    h("span", { class: "ctl-label" }, "Watch"),
    h(
      "div",
      { class: "seg", role: "group", "aria-label": "Watch" },
      ["auto", "on", "off"].map((mode) =>
        button(mode, () => void ctl.act("watch", { mode }), {
          kind: d.watch?.mode === mode ? "on" : "",
          disabled: dead("watch"),
        }),
      ),
    ),
    h("span", { class: "ctl-label" }, "Chat"),
    button(d.chat ? "On" : "Off", () => void ctl.act("chat", { on: !d.chat }), {
      kind: d.chat ? "on" : "",
      disabled: dead("chat"),
    }),
  )
}

const todos = (d) =>
  card(
    "Todos",
    d.todos.unavailable !== undefined
      ? unavailable(d.todos)
      : d.todos.value.length === 0
        ? h("p", { class: "hint" }, "No todos.")
        : h(
            "ul",
            { class: "todos" },
            d.todos.value.map((t) =>
              h(
                "li",
                { class: t.done ? "done" : "" },
                h("span", { "aria-hidden": "true" }, t.done ? "✓ " : "○ "),
                t.text,
              ),
            ),
          ),
  )

const card = (title, ...kids) =>
  h("section", { class: "card" }, h("h3", null, title), ...kids)

function pickers(state, ctl, d, can) {
  const o = state.options
  if (!o || d.blocked) return null
  const model = o.models.find((m) => m.ref === d.model)
  const sel = (label, items, current, onchange, extra = []) =>
    h(
      "label",
      { class: "pick" },
      h("span", null, label),
      h(
        "select",
        {
          disabled: !can,
          onchange: (e) => e.target.value && void onchange(e.target.value),
        },
        h("option", { value: "" }, current ? current : "Choose…"),
        items
          .filter((i) => i.value !== current)
          .map((i) => h("option", { value: i.value }, i.label)),
        ...extra,
      ),
    )
  return h(
    "div",
    { class: "picks" },
    o.agents.length > 0 &&
      sel(
        "Agent",
        o.agents.map((a) => ({ value: a, label: a })),
        d.agent,
        (agent) => ctl.act("agent", { agent }),
      ),
    o.models.length > 0 &&
      sel(
        "Model",
        o.models.map((m) => ({ value: m.ref, label: m.name })),
        model ? model.name : d.model,
        (m) => ctl.act("model", { model: m }),
      ),
    model &&
      model.variants.length > 0 &&
      sel(
        "Variant",
        model.variants.map((v) => ({ value: v, label: v })),
        d.variant,
        (variant) => ctl.act("model", { model: model.ref, variant }),
      ),
  )
}

function composer(ctl, d, can) {
  const working = d.state === "working"
  const key = "send:" + d.id
  const steer = "steer:" + d.id
  const off = !can || !!d.blocked
  const send = (e) => {
    const box = e.currentTarget.closest(".composer").querySelector("textarea")
    const text = (drafts[key] ?? "").trim()
    if (!text) return
    drafts[key] = ""
    box.value = ""
    void ctl.send(text, drafts[steer] ? "steer" : "queue")
  }
  return h(
    "div",
    { class: "composer" },
    working &&
      h(
        "button",
        {
          type: "button",
          class: "chip" + (drafts[steer] ? " on" : ""),
          "aria-pressed": drafts[steer] ? "true" : "false",
          title: "Inject into the running turn instead of queueing",
          disabled: off,
          onclick: (e) => {
            drafts[steer] = !drafts[steer]
            e.currentTarget.classList.toggle("on", drafts[steer])
            e.currentTarget.setAttribute(
              "aria-pressed",
              String(!!drafts[steer]),
            )
          },
        },
        "Steer",
      ),
    h(
      "div",
      { class: "compose-row" },
      field(
        key,
        {
          rows: "1",
          placeholder: "Message this session",
          "aria-label": "Message",
          disabled: off,
        },
        "textarea",
      ),
      h(
        "button",
        {
          type: "button",
          class: "send",
          "aria-label": working && drafts[steer] ? "Steer" : "Send",
          disabled: off,
          onclick: send,
        },
        icon("send"),
      ),
    ),
  )
}

function question(state, ctl, d, q, can) {
  if (!d.canAnswer)
    return card(
      q.title,
      h(
        "p",
        { class: "hint" },
        "Answer this at the Mac: no OpenCode window is open to take a reply.",
      ),
    )
  return card(
    q.title,
    h(
      "p",
      { class: "hint" },
      q.items.length === 1 ? "1 question" : q.items.length + " questions",
    ),
    button("Answer", () => void ctl.openPrompt(q.id), {
      kind: "primary",
      disabled: !can,
    }),
  )
}

function group(a, ctl, q, i) {
  const d = a.draft[i]
  const typed = "ans:" + a.id + ":" + i
  const row = (o) => {
    const on = d.chosen.includes(o)
    return h(
      "button",
      {
        type: "button",
        class: "btn opt" + (on ? " on" : ""),
        "aria-pressed": String(on),
        disabled: a.busy,
        onclick: () => ctl.edit(F.pick, i, o),
      },
      (on ? "✓ " : "") + F.plain(o),
      F.isRecommended(o) && pill("rec", "Recommended"),
    )
  }
  return card(
    q.header || q.text,
    q.header && q.text && h("p", { class: "ask" }, q.text),
    q.multiple && h("p", { class: "hint" }, "Choose any that apply."),
    h("div", { class: "opts" }, q.options.map(row)),
    q.custom &&
      (d.other
        ? button("✓ Other: " + d.other, () => ctl.edit(F.other, i, ""), {
            kind: "on",
            disabled: a.busy,
          })
        : h(
            "div",
            { class: "row" },
            field(typed, {
              type: "text",
              placeholder: "Other… type an answer",
              "aria-label": "Other… type an answer",
            }),
            button(
              "Use",
              () => {
                const text = drafts[typed] ?? ""
                drafts[typed] = ""
                ctl.edit(F.other, i, text)
              },
              { disabled: a.busy },
            ),
          )),
  )
}

function questionScreen(state, ctl) {
  const a = state.question
  if (!a) return empty("Loading…")
  if (a.gone)
    return card(
      "Question",
      h("p", null, "That question is no longer open."),
      button("Back", () => void ctl.go("list")),
    )
  if (a.sent)
    return card(
      "Question",
      h("p", null, a.text || "Sent."),
      button("Close", () => void ctl.go("list"), { kind: "primary" }),
    )
  return h(
    "section",
    null,
    h("p", { class: "hint" }, a.view.title),
    a.view.items.map((q, i) => group(a, ctl, q, i)),
    a.text && h("p", { class: "hint", role: "status" }, a.text),
    button("Send answers", () => void ctl.sendAnswers(), {
      kind: "primary",
      disabled: a.busy || !F.ready(a.view.items, a.draft),
    }),
  )
}

function permission(state, ctl, p, can) {
  const choices = permissionChoices(state.meta)
  if (choices.length === 0)
    return card(
      p.title,
      h(
        "p",
        { class: "hint" },
        "Permission replies from the app are off. Answer in the OpenCode TUI.",
      ),
    )
  const label = { once: "Allow once", always: "Always", reject: "Deny" }
  return card(
    p.title,
    h(
      "div",
      { class: "row wrap" },
      choices.map((c) =>
        button(label[c], () => void ctl.permission(p.id, c), {
          kind: c === "once" ? "primary" : c === "reject" ? "danger" : "",
          disabled: !can,
        }),
      ),
    ),
  )
}

function changes(state, ctl, d) {
  if (d.diff.unavailable !== undefined)
    return card("Changes", unavailable(d.diff))
  const { files, additions, deletions } = d.diff.value
  const key = "changes:" + d.id
  return card(
    "Changes",
    h(
      "details",
      {
        class: "more",
        open: drafts[key] ? true : undefined,
        ontoggle: (e) => (drafts[key] = e.target.open),
      },
      h(
        "summary",
        null,
        files.length +
          (files.length === 1 ? " file" : " files") +
          ", +" +
          additions +
          " −" +
          deletions,
      ),
      h(
        "ul",
        { class: "files" },
        files.map((f) =>
          h(
            "li",
            null,
            h("span", { class: "grow path" }, f.file),
            h("span", { class: "add" }, "+" + f.additions),
            h("span", { class: "del" }, "−" + f.deletions),
          ),
        ),
      ),
      files.length > 0 &&
        !state.patch &&
        button("View patch", () => void ctl.loadPatch()),
      state.patch &&
        h(
          "pre",
          { class: "patch" },
          state.patch.text
            .split("\n")
            .map((l) => h("span", { class: "ln " + diffClass(l) }, l + "\n")),
        ),
    ),
  )
}

function conversation(state, ctl, d, now) {
  if (d.tail.unavailable !== undefined)
    return card("Conversation", unavailable(d.tail))
  const all = [...state.older, ...d.tail.value]
  return h(
    "section",
    { class: "convo" },
    all.length === 0 ? h("p", { class: "hint pad" }, "No messages yet.") : null,
    !state.olderDone &&
      all.length > 0 &&
      button("Load older", () => void ctl.loadOlder(), { kind: "link" }),
    h(
      "ol",
      { class: "chat" },
      all.map((m) =>
        h(
          "li",
          { class: "msg " + m.role },
          h("div", { class: "bubble md" }, markdown(m.text)),
          h(
            "span",
            { class: "who" },
            (m.role === "user" ? "You" : "OpenCode") + " · " + ago(m.at, now),
          ),
        ),
      ),
    ),
  )
}

function newSession(state, ctl) {
  const o = state.options
  if (!o || o.projects.length === 0)
    return h(
      "section",
      { class: "card" },
      h("h2", null, "New session"),
      h(
        "p",
        { class: "hint" },
        "No project is configured to start sessions in. Add chat.projects in the bridge config.",
      ),
    )
  const can = ctl.canAct()
  const sel = (name, label, items, first) =>
    h(
      "label",
      { class: "pick" },
      h("span", null, label),
      h(
        "select",
        { onchange: (e) => (drafts[name] = e.target.value) },
        first && h("option", { value: "" }, first),
        items.map((i) =>
          h(
            "option",
            {
              value: i.value,
              selected:
                (drafts[name] ?? (first ? "" : items[0]?.value)) === i.value,
            },
            i.label,
          ),
        ),
      ),
    )
  drafts["new:project"] ??= o.projects[0].name
  return h(
    "section",
    { class: "card" },
    h("h2", null, "New session"),
    sel(
      "new:project",
      "Project",
      o.projects.map((p) => ({ value: p.name, label: p.name })),
    ),
    sel(
      "new:agent",
      "Agent",
      o.agents.map((a) => ({ value: a, label: a })),
      "Project default",
    ),
    sel(
      "new:model",
      "Model",
      o.models.map((m) => ({ value: m.ref, label: m.name })),
      "Project default",
    ),
    h(
      "label",
      { class: "pick" },
      h("span", null, "First message"),
      field(
        "new:text",
        { rows: "4", placeholder: "What should it do?" },
        "textarea",
      ),
    ),
    button(
      "Start",
      () => {
        const text = (drafts["new:text"] ?? "").trim()
        if (!text) return
        const body = { project: drafts["new:project"], text }
        if (drafts["new:agent"]) body.agent = drafts["new:agent"]
        if (drafts["new:model"]) body.model = drafts["new:model"]
        drafts["new:text"] = ""
        void ctl.create(body)
      },
      { kind: "primary", disabled: !can },
    ),
  )
}

function night(state, ctl) {
  const n = state.status?.night
  const can = ctl.canAct()
  return h(
    "section",
    null,
    card(
      "Overnight plan",
      !n
        ? h("p", { class: "hint" }, "No overnight plan.")
        : [
            h(
              "p",
              null,
              n.ended
                ? "Ended (" + n.ended + ")."
                : "Running until " + hhmm(n.until) + ".",
            ),
            h(
              "ul",
              { class: "files" },
              n.sessions.map((s) =>
                h(
                  "li",
                  null,
                  h("span", { class: "grow path" }, s.title || s.id),
                  h(
                    "span",
                    { class: "sub" },
                    s.turns +
                      " turns · " +
                      s.tasksDone +
                      "/" +
                      s.tasks +
                      " tasks" +
                      (s.needs ? " · " + s.needs + " need you" : "") +
                      (s.stopped ? " · stopped: " + s.stopped : ""),
                  ),
                ),
              ),
            ),
            !n.ended &&
              button("End plan", () => ctl.ask("endNight"), {
                kind: "danger",
                disabled: !can,
              }),
          ],
      h(
        "p",
        { class: "hint" },
        "A plan is started from the OpenCode window, never from here.",
      ),
    ),
    card(
      "Digest",
      !state.digest
        ? h("p", { class: "hint" }, "Loading…")
        : !state.digest.enabled
          ? h("p", { class: "hint" }, "The digest is not enabled.")
          : h(
              "pre",
              { class: "digest" },
              state.digest.text || "Nothing to report.",
            ),
    ),
  )
}

const FACTOR = {
  biometric: ["Face ID", "Approve with Face ID"],
  passkey: ["Passkey", "Approve with a passkey"],
  totp: ["Code", "Approve with code"],
}

const until = (iso) => {
  const t = new Date(iso)
  return Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function approval(state, ctl) {
  const a = state.approval
  if (!a) return empty("Loading…")
  if (a.gone)
    return card(
      "Approval",
      h("p", null, "This request is not waiting for you any more."),
      button("Back", () => void ctl.go("list")),
    )
  if (a.done)
    return card(
      "Approval",
      h("p", null, a.text),
      button("Close", () => void ctl.go("list"), { kind: "primary" }),
    )
  const v = a.view
  const f = a.factors[a.index]
  return h(
    "section",
    null,
    card(
      "Approve #" + v.short,
      h(
        "dl",
        { class: "kv" },
        h("dt", null, "Who asks"),
        h("dd", null, v.caller),
        h("dt", null, "What"),
        h("dd", null, v.scope),
        h("dt", null, "Class"),
        h("dd", null, v.action_class),
        h("dt", null, "Level"),
        h("dd", null, "L" + v.level),
        h("dt", null, "Expires"),
        h("dd", null, until(v.expires_at)),
        v.reason && h("dt", null, "Reason"),
        v.reason && h("dd", null, v.reason),
      ),
      h("p", { class: "hint" }, "The value never goes to Telegram or the AI."),
    ),
    card(
      v.level >= 2 ? (f ? FACTOR[f][0] : "No method") : "Decision",
      v.level < 2 &&
        button("Approve", () => void ctl.decide("approve"), {
          kind: "primary",
          disabled: a.busy,
        }),
      v.level >= 2 &&
        !f &&
        h(
          "p",
          { class: "hint" },
          "Nothing on this phone can prove it. Answer at the Mac.",
        ),
      v.level >= 2 &&
        f === "totp" &&
        field("approval-code", {
          inputmode: "numeric",
          autocomplete: "one-time-code",
          maxlength: 6,
          placeholder: "123456",
          "aria-label": "6-digit code",
        }),
      v.level >= 2 &&
        f &&
        button(FACTOR[f][1], () => void ctl.verify(drafts["approval-code"]), {
          kind: "primary",
          disabled: a.busy,
        }),
      button("Deny", () => void ctl.decide("deny"), {
        kind: "danger",
        disabled: a.busy,
      }),
      a.factors.length > 1 &&
        button("Use another method", () => ctl.useAnother(), {
          disabled: a.busy,
        }),
      a.text && h("p", { class: "hint", role: "status" }, a.text),
    ),
  )
}

function enroll(state, ctl) {
  const e = state.enrol
  if (e?.ok)
    return h(
      "section",
      null,
      card(
        "This phone is set up",
        h("p", { class: "hint", role: "status" }, e.text),
        e.device && h("p", { class: "hint" }, "Enrolled device: " + e.device),
        h(
          "p",
          { class: "hint" },
          "The code is used up. To add another phone, open a new one at the Mac.",
        ),
        button("Done", () => void ctl.go("list"), { kind: "primary" }),
      ),
    )
  const scanned = state.enrolCode
  if (scanned && drafts["enrol-code"] === undefined)
    drafts["enrol-code"] = scanned.replace(/^(.{4})(.+)$/, "$1-$2")
  const face = button(
    "Face ID",
    () => void ctl.enroll("biometric", drafts["enrol-code"] ?? ""),
    {
      kind: "primary",
      disabled: e?.busy,
    },
  )
  // A scanned code needs one tap: the button that asks for Face ID has the focus.
  if (scanned && !e) setTimeout(() => face.focus(), 0)
  return h(
    "section",
    null,
    card(
      "Set up this phone",
      h(
        "p",
        { class: "hint" },
        scanned
          ? "The code from the Mac is filled in. Tap Face ID, or Passkey."
          : "At the Mac, run the Enrol Face ID or Enrol a passkey command in the approvals menu, then enter the code it shows.",
      ),
      field("enrol-code", {
        autocomplete: "off",
        autocapitalize: "characters",
        maxlength: 9,
        placeholder: "ABCD-EFGH",
        "aria-label": "Code from the Mac",
      }),
      h(
        "div",
        { class: "row" },
        face,
        button(
          "Passkey",
          () => void ctl.enroll("passkey", drafts["enrol-code"] ?? ""),
          {
            disabled: e?.busy,
          },
        ),
      ),
      e?.text && h("p", { class: "hint", role: "status" }, e.text),
    ),
  )
}

function info(state, ctl, now) {
  const m = state.meta
  const s = state.status
  return h(
    "section",
    null,
    isStale(ctl.build, m?.app) &&
      card(
        "Old copy of the app",
        h(
          "p",
          { class: "hint" },
          "This page is not the build the bridge serves now. Reload it to get the new one.",
        ),
        button("Reload", () => globalThis.location.reload(), {
          kind: "primary",
        }),
      ),
    card(
      "Bridge",
      h(
        "dl",
        { class: "kv" },
        h("dt", null, "Version"),
        h("dd", null, m?.version ?? "unknown"),
        h("dt", null, "Core API"),
        h("dd", null, m?.api ?? "unknown"),
        h("dt", null, "Installed"),
        h("dd", null, s?.versions?.installed ?? "unknown"),
        h("dt", null, "Server runs"),
        h("dd", null, s?.owner?.version ?? "unknown"),
        h("dt", null, "Away mode"),
        h(
          "dd",
          null,
          s?.afk ? s.afk.mode + (s.afk.away ? " (away)" : "") : "unknown",
        ),
        h("dt", null, "Waiting on you"),
        h("dd", null, String(s?.pending ?? 0)),
        h("dt", null, "Permissions"),
        h("dd", null, m?.permissions ?? "off"),
      ),
    ),
    card(
      "Channels",
      !s
        ? empty("Loading…")
        : h(
            "ul",
            { class: "files" },
            s.channels.map((c) =>
              h(
                "li",
                null,
                h("span", { class: "grow path" }, c.id),
                h(
                  "span",
                  { class: "sub" },
                  !c.enabled ? "off" : c.connected === false ? "down" : "up",
                ),
              ),
            ),
          ),
    ),
    m?.approvals &&
      card(
        "Approvals",
        h(
          "p",
          { class: "hint" },
          "Face ID or a passkey for level 2 approvals.",
        ),
        button("Set up this phone", () => void ctl.go("enroll")),
      ),
    card(
      "Actions",
      h(
        "ul",
        { class: "files" },
        (m?.actions ?? []).map((a) =>
          h(
            "li",
            null,
            h("span", { class: "name" }, a.name),
            h("span", { class: "sub" }, a.available ? "available" : a.reason),
          ),
        ),
      ),
    ),
    h(
      "p",
      { class: "hint foot" },
      aboutLine(m?.version, s?.owner?.startedAt, now, ctl.build),
    ),
  )
}

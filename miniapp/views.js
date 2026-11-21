// Drawing. Every string from the API goes in as text, never as markup.
import {
  ago,
  connection,
  diffClass,
  hhmm,
  nameOf,
  permissionChoices,
  stateLabel,
} from "./format.js"
import * as F from "./form.js"

export function h(tag, props, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === "class") el.className = v
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
    else if (k === "value") el.value = v
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

export function render(state, ctl, now) {
  const { phase } = state
  const body = phase === "ready" ? screen(state, ctl, now) : notice(phase, ctl)
  return h(
    "div",
    { class: "app" },
    header(state, now),
    phase === "ready" && state.conn !== "live" && banner(state),
    h("main", { class: "main" }, body),
    phase === "ready" && tabs(state, ctl),
    state.toast &&
      now - state.toast.at < 4000 &&
      h(
        "div",
        { class: "toast " + (state.toast.ok ? "ok" : "bad"), role: "status" },
        state.toast.text,
      ),
    state.confirm && confirmSheet(state, ctl),
  )
}

function header(state, now) {
  const c = connection(state, now)
  return h(
    "header",
    { class: "top" },
    h(
      "h1",
      null,
      { session: "Session", new: "New session", night: "Night", info: "Info" }[
        state.route.name
      ] ?? "Sessions",
    ),
    state.phase === "ready" && pill(c.key, c.text),
  )
}

const banner = (state) =>
  h(
    "div",
    { class: "banner", role: "alert" },
    "Not connected: what you see may be out of date, and actions are off.",
    state.updatedAt ? " Last update " + hhmm(state.updatedAt) + "." : "",
  )

function notice(phase, ctl) {
  const text = {
    loading: "Loading…",
    nolaunch:
      "Open this app from Telegram: it has no way to know who you are here.",
    expired:
      "This view has expired. Close it and open the app again from Telegram.",
    forbidden: "Not authorised. This app is for the person who set up the bot.",
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
  const tab = (name, label, icon) =>
    h(
      "button",
      {
        type: "button",
        class: "tab" + (at === name ? " on" : ""),
        "aria-current": at === name ? "page" : undefined,
        onclick: () => void ctl.go(name),
      },
      h("span", { class: "ico", "aria-hidden": "true" }, icon),
      label,
    )
  return h(
    "nav",
    { class: "tabs" },
    tab("list", "Sessions", "☰"),
    tab("new", "New", "＋"),
    tab("night", "Night", "☾"),
    tab("info", "Info", "ⓘ"),
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

function screen(state, ctl, now) {
  switch (state.route.name) {
    case "session":
      return session(state, ctl, now)
    case "new":
      return newSession(state, ctl)
    case "night":
      return night(state, ctl)
    case "info":
      return info(state)
    default:
      return list(state, ctl, now)
  }
}

function list(state, ctl, now) {
  if (state.sessions.length === 0)
    return empty("No sessions yet. Start one from the New tab.")
  return h(
    "ul",
    { class: "list" },
    state.sessions.map((s) => {
      const st = stateLabel(s)
      return h(
        "li",
        null,
        h(
          "button",
          {
            type: "button",
            class: "row-btn",
            "data-id": s.id,
            onclick: () => void ctl.open(s.id),
          },
          h("span", { class: "dot " + st.key, "aria-hidden": "true" }),
          h(
            "span",
            { class: "grow" },
            h("span", { class: "title" }, nameOf(s)),
            h(
              "span",
              { class: "sub" },
              [s.project, s.agent, s.model].filter(Boolean).join(" · "),
            ),
            h(
              "span",
              { class: "tags" },
              pill(st.key, st.text),
              s.watch?.mode !== "off" && pill("mode", "watch " + s.watch.mode),
              s.chat && pill("mode", "chat"),
              s.blocked && pill("failed", "blocked"),
            ),
          ),
          h("span", { class: "when" }, ago(s.lastActivity, now)),
        ),
      )
    }),
    state.total > state.sessions.length &&
      h(
        "li",
        { class: "hint pad" },
        state.sessions.length + " of " + state.total + " shown",
      ),
  )
}

const available = (meta, name) => meta?.actions?.find((a) => a.name === name)

function session(state, ctl, now) {
  const d = state.detail
  const back = button("‹ Sessions", () => void ctl.go("list"), { kind: "link" })
  if (!d) return h("section", null, back, empty("Loading…"))
  const st = stateLabel(d)
  const can = ctl.canAct()
  const act = (name, label, kind) => {
    const a = available(state.meta, name)
    const off = a && !a.available
    return button(
      label,
      () => (name === "compact" ? void ctl.act(name) : ctl.ask(name)),
      {
        kind,
        disabled: !can || off || !!d.blocked,
        title: off ? a.reason : undefined,
      },
    )
  }
  return h(
    "section",
    null,
    back,
    h(
      "div",
      { class: "card" },
      h("h2", null, nameOf(d)),
      h(
        "div",
        { class: "tags" },
        pill(st.key, st.text),
        d.watch?.mode !== "off" && pill("mode", "watch " + d.watch.mode),
      ),
      h(
        "p",
        { class: "sub" },
        [d.project, d.agent, d.model, d.variant].filter(Boolean).join(" · "),
      ),
      d.blocked &&
        h(
          "p",
          { class: "hint" },
          "Blocked by chat.deny (" +
            d.blocked +
            "): nothing here can be changed.",
        ),
      h(
        "div",
        { class: "row wrap" },
        d.state === "working" && act("stop", "Stop", "danger"),
        (d.state === "suspended" || d.stuck) &&
          act("resume", "Resume", "primary"),
        act("undo", "Undo"),
        act("compact", "Compact"),
      ),
      pickers(state, ctl, d, can),
    ),
    d.questions.map((q) => question(state, ctl, d, q, can)),
    d.permissions.map((p) => permission(state, ctl, p, can)),
    composer(ctl, d, can),
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
    ),
    changes(state, ctl, d),
    conversation(state, ctl, d, now),
  )
}

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
  const send = (delivery) => {
    const text = (drafts["send:" + d.id] ?? "").trim()
    if (!text) return
    drafts["send:" + d.id] = ""
    void ctl.send(text, delivery)
  }
  return card(
    "Message",
    field(
      "send:" + d.id,
      {
        rows: "2",
        placeholder: "Message this session",
        "aria-label": "Message",
        disabled: !can || !!d.blocked,
      },
      "textarea",
    ),
    h(
      "div",
      { class: "row wrap" },
      button(working ? "Queue" : "Send", () => send("queue"), {
        kind: "primary",
        disabled: !can || !!d.blocked,
      }),
      working &&
        button("Steer", () => send("steer"), {
          disabled: !can || !!d.blocked,
          title: "Inject into the running turn",
        }),
      button("Continue", () => void ctl.send("continue"), {
        disabled: !can || !!d.blocked,
      }),
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
  const f = ctl.form(q)
  const one = F.oneTap(q.items)
  const go = (fn, ...args) => void ctl.step(q, fn, ...args)
  if (F.reviewing(f))
    return card(
      q.title,
      h(
        "ul",
        { class: "review" },
        q.items.map((it, i) =>
          h(
            "li",
            null,
            h("strong", null, it.header || it.text),
            h("br"),
            f.chosen[i].join(", "),
          ),
        ),
      ),
      h(
        "div",
        { class: "row" },
        button("Submit", () => void ctl.submit(q), {
          kind: "primary",
          disabled: !can || !F.complete(f),
        }),
        button("Edit", () => go(F.restart)),
        button("Cancel", () => ctl.cancelForm(q)),
      ),
    )
  const item = q.items[f.at]
  const typed = "ans:" + q.id + ":" + f.at
  return card(
    q.title,
    !one &&
      h(
        "p",
        { class: "hint" },
        "Question " + (f.at + 1) + " of " + q.items.length,
      ),
    h("p", { class: "ask" }, item.text || item.header),
    h(
      "div",
      { class: "opts" },
      item.options.map((o) =>
        button(
          (item.multiple && f.chosen[f.at].includes(o) ? "✓ " : "") + o,
          () => go(F.pick, o),
          {
            kind: item.multiple && f.chosen[f.at].includes(o) ? "on" : "",
            disabled: !can,
          },
        ),
      ),
    ),
    item.custom &&
      h(
        "div",
        { class: "row" },
        field(typed, {
          type: "text",
          placeholder: "Type an answer",
          "aria-label": "Type an answer",
        }),
        button(
          "Use",
          () => {
            const t = drafts[typed] ?? ""
            drafts[typed] = ""
            go(F.type, t)
          },
          { disabled: !can },
        ),
      ),
    h(
      "div",
      { class: "row" },
      f.at > 0 && button("‹ Back", () => go(F.back)),
      item.multiple &&
        button("Done", () => go(F.next), {
          kind: "primary",
          disabled: !can || f.chosen[f.at].length === 0,
        }),
    ),
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
  return card(
    "Changes",
    h(
      "p",
      { class: "sub" },
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
  )
}

function conversation(state, ctl, d, now) {
  if (d.tail.unavailable !== undefined)
    return card("Conversation", unavailable(d.tail))
  const all = [...state.older, ...d.tail.value]
  return card(
    "Conversation",
    all.length === 0 ? h("p", { class: "hint" }, "No messages yet.") : null,
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
          h("span", { class: "who" }, m.role + " · " + ago(m.at, now)),
          h("span", { class: "txt" }, m.text),
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

function info(state) {
  const m = state.meta
  const s = state.status
  return h(
    "section",
    null,
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
  )
}

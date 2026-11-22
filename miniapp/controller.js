// The app's state and what the person can do. No DOM here: views.js draws it, the tests drive it.
import { ApiError } from "./api.js"
import { orderFactors } from "./factors.js"
import * as F from "./form.js"
import { parseStart } from "./format.js"

export const CONFIRM = {
  stop: "Stop the running turn?",
  undo: "Undo the last turn?",
  resume: "Resume this session?",
  endNight: "End the overnight plan? Nothing acts automatically after that.",
}

const REFRESH_MS = 300

const initial = () => ({
  build: "",
  /** loading | ready | nolaunch | expired | forbidden | offline */
  phase: "loading",
  /** The code the bridge gave when it refused: the screen says why. */
  reason: undefined,
  /** connecting | live | down */
  conn: "connecting",
  updatedAt: 0,
  meta: undefined,
  status: undefined,
  options: undefined,
  sessions: [],
  total: 0,
  route: { name: "list" },
  detail: undefined,
  older: [],
  olderDone: false,
  patch: undefined,
  forms: {},
  confirm: undefined,
  toast: undefined,
  digest: undefined,
  busy: false,
  approval: undefined,
  enrol: undefined,
  /** The code a scanned QR carried: the enrolment screen starts with it filled in. */
  enrolCode: undefined,
})

export function createController({
  api,
  makeStream,
  now = Date.now,
  start = "",
  device,
  build = "",
}) {
  let s = initial()
  const subs = new Set()
  let timer
  let stream
  let wasLive = false
  const set = (patch) => {
    s = { ...s, ...patch }
    for (const f of subs) f(s)
  }
  const toast = (text, ok = true) => set({ toast: { text, ok, at: now() } })
  const touch = () => set({ updatedAt: now() })

  const say = (err) =>
    ({
      expired: "This view has expired.",
      forbidden: "This account may not use the app.",
      limited: "Too many failed requests: wait a few minutes.",
      offline: "The Mac cannot be reached.",
    })[err.kind] ?? "The request failed."

  /** Runs a request; a refusal of the whole session ends the app's use of the data. */
  async function guard(fn) {
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      if (err.kind === "forbidden")
        set({
          ...initial(),
          phase: "forbidden",
          conn: "down",
          reason: err.reason,
        })
      else if (err.kind === "expired")
        set({ phase: "expired", conn: "down", reason: err.reason })
      else if (err.kind === "offline") set({ conn: "down" })
      throw err
    }
  }

  const quiet = (p) => p.catch(() => undefined)

  async function loadList() {
    const l = await guard(() => api.sessions())
    set({ sessions: l.sessions, total: l.total })
    touch()
  }
  async function loadStatus() {
    set({ status: await guard(() => api.status()) })
  }
  async function loadDetail(id) {
    const d = await guard(() => api.session(id))
    if (s.route.name === "session" && s.route.id === id) set({ detail: d })
    touch()
  }

  async function refresh() {
    const jobs = [quiet(loadList()), quiet(loadStatus())]
    if (s.route.name === "session") jobs.push(quiet(loadDetail(s.route.id)))
    await Promise.all(jobs)
  }

  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), REFRESH_MS)
  }

  const self = {
    /** The build of the files this page was loaded from. */
    build,
    get state() {
      return s
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },

    /**
     * Session actions need a live stream: without one the screen may be out of date. Approvals and
     * enrolment read nothing from it, so a stream that is down must not stop them.
     */
    canAct() {
      const alone = s.route.name === "approval" || s.route.name === "enroll"
      return s.phase === "ready" && !s.busy && (s.conn === "live" || alone)
    },

    async boot() {
      if (!api.initData) return set({ phase: "nolaunch" })
      try {
        set({ meta: await guard(() => api.meta()) })
      } catch (err) {
        if (s.phase === "loading")
          set({ phase: err instanceof ApiError ? "offline" : "loading" })
        return
      }
      set({ phase: "ready" })
      await Promise.all([
        quiet(loadList()),
        quiet(loadStatus()),
        quiet(guard(() => api.options()).then((options) => set({ options }))),
      ])
      const target = parseStart(start)
      if (target?.kind === "approval") await self.openApproval(target.id)
      else if (target?.kind === "session") await self.open(target.id)
      else if (target?.kind === "enrol") {
        set({ enrolCode: target.code })
        await self.go("enroll")
      }
      stream = makeStream({
        onState: (state, why, reason) => {
          if (why === "expired")
            return set({ phase: "expired", conn: "down", reason })
          if (why === "forbidden")
            return set({
              ...initial(),
              phase: "forbidden",
              conn: "down",
              reason,
            })
          set({ conn: state })
          if (state === "live" && wasLive) later()
          if (state === "live") wasLive = true
        },
        onEvent: (e) => {
          touch()
          if (e.type === "snapshot" && e.data?.sessions)
            set({ sessions: e.data.sessions, total: e.data.total })
          else later()
        },
        onBeat: touch,
      })
      stream.start()
    },

    stop() {
      stream?.stop()
      clearTimeout(timer)
    },

    refresh,

    async go(name, extra = {}) {
      set({ route: { name, ...extra }, confirm: undefined })
      if (name === "list") return refresh()
      if (name === "night") {
        await quiet(loadStatus())
        await self.loadDigest()
      }
      if (name === "enroll") set({ enrol: undefined })
      if (name === "info")
        await Promise.all([
          quiet(loadStatus()),
          quiet(guard(() => api.meta()).then((meta) => set({ meta }))),
        ])
    },

    async open(id) {
      set({
        route: { name: "session", id },
        detail: undefined,
        older: [],
        olderDone: false,
        patch: undefined,
        confirm: undefined,
      })
      try {
        await loadDetail(id)
      } catch (err) {
        if (err instanceof ApiError && [400, 404].includes(err.status)) {
          toast("That session is not there any more.", false)
          set({ route: { name: "list" } })
        }
      }
    },

    /** The second factor of an L2 request: the first one this phone can use, then the others on demand. */
    async openApproval(id) {
      set({
        route: { name: "approval", id },
        approval: undefined,
        confirm: undefined,
      })
      try {
        const view = await guard(() => api.approval(id))
        const support = (await device?.support(view)) ?? {}
        set({
          approval: {
            id,
            view,
            factors: orderFactors(view.factors, support),
            index: 0,
            support,
          },
        })
      } catch (err) {
        if (err instanceof ApiError && err.status === 404)
          set({ approval: { id, gone: true } })
      }
    },

    useAnother() {
      const a = s.approval
      if (a?.factors?.length > 1)
        set({
          approval: {
            ...a,
            index: (a.index + 1) % a.factors.length,
            text: undefined,
          },
        })
    },

    /** Proves the factor on screen. `code` is the typed code for the code factor. */
    async verify(code) {
      const a = s.approval
      const factor = a?.factors?.[a.index]
      if (!a || !factor || a.busy) return
      set({ approval: { ...a, busy: true, text: undefined } })
      const fail = (text) =>
        set({ approval: { ...s.approval, busy: false, text } })
      let body
      if (factor === "totp") {
        if (!/^\d{6}$/.test(code ?? "")) return fail("Type the 6 digits.")
        body = { factor, code }
      } else {
        const p = await device[
          factor === "biometric" ? "biometricProof" : "passkeyProof"
        ](a.view)
        if (p.error) return fail(p.error)
        body = { factor, challenge: a.view.challenge, ...p }
      }
      let r
      try {
        r = await guard(() => api.approvalProof(a.id, body))
      } catch (err) {
        return fail(err instanceof ApiError ? say(err) : "The request failed.")
      }
      if (r?.ok)
        return set({
          approval: {
            ...s.approval,
            busy: false,
            done: true,
            ok: true,
            text: r.text,
          },
        })
      if (r?.state)
        return set({
          approval: {
            ...s.approval,
            busy: false,
            done: true,
            ok: false,
            text: r.text,
          },
        })
      // A failed proof spends the challenge: ask for a new one.
      try {
        const view = await guard(() => api.approval(a.id))
        set({ approval: { ...s.approval, view, busy: false, text: r?.text } })
      } catch {
        fail(r?.text ?? "The request failed.")
      }
    },

    /** Enrols this phone with the code shown at the Mac. */
    async enroll(kind, code) {
      if (s.enrol?.busy) return
      const say2 = (text, ok = false) =>
        set({ enrol: { busy: false, text, ok } })
      set({ enrol: { busy: true } })
      try {
        if (kind === "biometric") {
          const ready = await device.prepareBiometric()
          if (ready.error) return say2(ready.error)
          const r = await guard(() => api.enrol({ kind, code }))
          if (!r?.ok) return say2(r?.text ?? "Not enrolled.")
          if (!(await device.saveToken(r.token)))
            return say2(
              "Telegram did not keep the secret. Revoke " +
                r.device +
                " at the Mac and start again.",
            )
          return say2("Face ID is set up on this phone.", true)
        }
        const begun = await guard(() => api.enrol({ kind, code }))
        if (!begun?.ok) return say2(begun?.text ?? "Not enrolled.")
        const made = await device.createPasskey(begun)
        if (made.error) return say2(made.error)
        const done = await guard(() =>
          api.enrol({ kind, code, credential: made.credential }),
        )
        return done?.ok
          ? say2("The passkey is set up.", true)
          : say2(done?.text ?? "Not enrolled.")
      } catch (err) {
        say2(err instanceof ApiError ? say(err) : "The request failed.")
      }
    },

    async loadOlder() {
      const id = s.route.id
      const all = [...s.older, ...(s.detail?.tail?.value ?? [])]
      const before = all[0]?.at
      if (before === undefined) return
      const m = await quiet(guard(() => api.messages(id, before)))
      if (!m || !("value" in m)) return set({ olderDone: true })
      set({ older: [...m.value, ...s.older], olderDone: m.value.length === 0 })
    },

    async loadPatch() {
      const id = s.route.id
      try {
        const text = await guard(() => api.patch(id))
        set({
          patch: {
            text: typeof text === "string" ? text : (text?.unavailable ?? ""),
          },
        })
      } catch {
        set({ patch: { text: "The patch could not be read." } })
      }
    },

    async loadDigest() {
      set({ digest: await quiet(guard(() => api.digest())) })
    },

    /** One action on the open session; the core's own refusal text is shown as it is. */
    async act(name, body = {}, id = s.route.id) {
      if (!self.canAct()) return
      set({ busy: true })
      try {
        const r = await guard(() => api.action(id, name, body))
        toast(r?.text || (r?.ok ? "Done." : "Not done."), r?.ok === true)
        if (r?.ok) set({ confirm: undefined })
      } catch (err) {
        toast(err instanceof ApiError ? say(err) : "The request failed.", false)
      } finally {
        set({ busy: false })
      }
      await refresh()
    },

    /** Stop, undo and resume ask first. */
    ask(kind, id = s.route.id) {
      if (!self.canAct()) return
      set({ confirm: { kind, id, text: CONFIRM[kind] } })
    },
    cancel() {
      set({ confirm: undefined })
    },
    async confirmed() {
      const c = s.confirm
      if (!c || !self.canAct()) return
      set({ confirm: undefined })
      if (c.kind === "endNight") {
        set({ busy: true })
        try {
          const r = await guard(() => api.endNight())
          toast(r?.text ?? "Done.", r?.ok === true)
        } catch (err) {
          toast(
            err instanceof ApiError ? say(err) : "The request failed.",
            false,
          )
        } finally {
          set({ busy: false })
        }
        return refresh()
      }
      return self.act(c.kind, {}, c.id)
    },

    send(text, delivery) {
      return self.act("prompt", { text, ...(delivery ? { delivery } : {}) })
    },

    permission(promptId, decision) {
      return self.act("permission", { prompt: promptId, decision })
    },

    /** The form of a prompt, made on first use. */
    form(prompt) {
      return s.forms[prompt.id] ?? F.newForm(prompt.items)
    },
    /** Applies a step of form.js; a one-tap field is sent at once. */
    async step(prompt, fn, ...args) {
      const f = fn(self.form(prompt), ...args)
      set({ forms: { ...s.forms, [prompt.id]: f } })
      if (F.oneTap(prompt.items) && F.reviewing(f)) await self.submit(prompt)
    },
    async submit(prompt) {
      const f = self.form(prompt)
      if (!F.complete(f)) return
      await self.act("answer", F.body(f, prompt.id))
      const { [prompt.id]: _gone, ...rest } = s.forms
      set({ forms: rest })
    },
    cancelForm(prompt) {
      const { [prompt.id]: _gone, ...rest } = s.forms
      set({ forms: rest })
    },

    async create(body) {
      if (!self.canAct()) return
      set({ busy: true })
      try {
        const r = await guard(() => api.create(body))
        toast(r?.text ?? "Started.", r?.ok === true)
        if (r?.ok && r.id) {
          set({ busy: false })
          return self.open(r.id)
        }
      } catch (err) {
        toast(err instanceof ApiError ? say(err) : "The request failed.", false)
      } finally {
        set({ busy: false })
      }
    },
  }
  return self
}

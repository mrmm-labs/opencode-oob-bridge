// Launch parameters, theme and the events the app sends to Telegram. Telegram's own script
// (telegram-web-app.js) is loaded by the page, and used where it is there: the biometric manager is
// the one thing the page cannot do reliably by hand. Without it the page speaks the event protocol
// itself, and everything it needs at launch is in the URL hash.

const START = /^[A-Za-z0-9_-]{1,64}$/

/** Reads what Telegram put in the URL: the init data, the theme and the session to open. */
export function launch(loc = globalThis.location) {
  const hash = new URLSearchParams((loc.hash || "").replace(/^#/, ""))
  const query = new URLSearchParams(loc.search || "")
  let theme = {}
  try {
    const t = JSON.parse(hash.get("tgWebAppThemeParams") || "{}")
    if (t && typeof t === "object") theme = t
  } catch {}
  const start = hash.get("tgWebAppStartParam") || query.get("s") || ""
  return {
    initData: hash.get("tgWebAppData") || "",
    theme,
    start: START.test(start) ? start : "",
    version: hash.get("tgWebAppVersion") || "",
    platform: hash.get("tgWebAppPlatform") || "",
  }
}

let reporter = () => {}

/** Where diagnostic lines go: the page sets it to the bridge's log. It must never be given a credential. */
export function setReporter(fn) {
  reporter = fn
}

/** One short diagnostic line. */
export function note(event, data = {}) {
  try {
    reporter(event, data)
  } catch {}
}

/** Tells Telegram the app is ready and may use the whole sheet. */
export function ready(win = globalThis) {
  post(win, "web_app_ready")
  post(win, "web_app_expand")
}

const listeners = new Set()

/** Calls `fn(type, data)` for every event Telegram sends; returns the way to stop. */
export function onEvent(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function post(win, eventType, eventData = {}) {
  if (win.TelegramWebviewProxy?.postEvent)
    win.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData))
  else if (win.parent && win.parent !== win)
    win.parent.postMessage(JSON.stringify({ eventType, eventData }), "*")
}

const hex = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || "")
  return m
    ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
    : undefined
}

const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two #rrggbb colours; undefined when one is not a colour. */
export function contrast(a, b) {
  const x = hex(a)
  const y = hex(b)
  if (!x || !y) return undefined
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

/** `fg` when it reads on `bg` at 4.5:1, else the first fallback that does, else black or white. */
export function readable(fg, bg, ...fallbacks) {
  for (const c of [fg, ...fallbacks])
    if ((contrast(c, bg) ?? 0) >= 4.5) return c
  return (contrast("#000000", bg) ?? 0) >= (contrast("#ffffff", bg) ?? 0)
    ? "#000000"
    : "#ffffff"
}

/** The CSS variables for a Telegram theme; text colours are corrected where the theme would not reach 4.5:1. */
export function themeVars(t) {
  if (!hex(t.bg_color) || !hex(t.text_color)) return {}
  const bg = t.bg_color
  const bg2 = hex(t.secondary_bg_color) ? t.secondary_bg_color : bg
  const text = readable(t.text_color, bg)
  const btn = hex(t.button_color) ? t.button_color : text
  return {
    "--bg": bg,
    "--bg2": bg2,
    "--text": text,
    "--hint": readable(t.hint_color, bg2, text),
    "--link": readable(t.link_color, bg, text),
    "--btn": btn,
    "--btn-text": readable(t.button_text_color, btn),
    "--danger": readable(t.destructive_text_color, bg2, text),
    "--scheme": lum(hex(bg)) < 0.4 ? "dark" : "light",
  }
}

export function applyTheme(t, root = globalThis.document.documentElement) {
  const vars = themeVars(t)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  if (vars["--scheme"]) root.style.setProperty("color-scheme", vars["--scheme"])
}

/**
 * Follows Telegram's theme_changed event: a message in the web clients, a call on
 * `Telegram.WebView.receiveEvent` in the native ones, which this defines.
 */
export function followTheme(win = globalThis) {
  const on = (type, raw) => {
    let data = raw
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw)
      } catch {}
    }
    if (type === "theme_changed" && data?.theme_params)
      applyTheme(data.theme_params, win.document.documentElement)
    for (const f of listeners) f(type, data)
  }
  win.addEventListener("message", (e) => {
    try {
      const m = typeof e.data === "string" ? JSON.parse(e.data) : e.data
      on(m?.eventType, m?.eventData)
    } catch {}
  })
  if (sdk(win)) {
    // Telegram's script owns the receive hooks: ask it for the events instead of replacing them.
    win.Telegram.WebApp.onEvent?.("themeChanged", () =>
      applyTheme(
        win.Telegram.WebApp.themeParams ?? {},
        win.document.documentElement,
      ),
    )
    return
  }
  hooks(win, on)
}

/** Telegram's script, when the page loaded it. */
const sdk = (win) => (win.Telegram?.WebApp ? win.Telegram.WebApp : undefined)

/**
 * The native clients answer by calling one of these. Telegram's own script defines all three, so
 * the page does the same: a reply that arrives on a name nobody defined is lost.
 */
function hooks(win, on) {
  win.Telegram = {
    ...win.Telegram,
    WebView: { ...win.Telegram?.WebView, receiveEvent: on },
  }
  win.TelegramGameProxy = { ...win.TelegramGameProxy, receiveEvent: on }
  win.TelegramGameProxy_receiveEvent = on
}

const biometryInfo = (d) => ({
  available: d?.available === true,
  type: d?.type,
  accessGranted: d?.access_granted === true,
  tokenSaved: d?.token_saved === true,
})

/**
 * Telegram's biometric manager, over the events its documentation names
 * (web_app_biometry_*). The app does not load Telegram's script, so it sends and
 * reads them itself. A client that never answers (an old one) gives `undefined`
 * after the timeout, and every method then reports "not available".
 */
export function biometric(
  win = globalThis,
  { timeoutMs = 3000, authMs = 60_000 } = {},
) {
  const manager = () => sdk(win)?.BiometricManager
  const ask = (event, data, reply, ms = timeoutMs) =>
    new Promise((resolve) => {
      const off = onEvent((type, d) => {
        if (type !== reply) return
        clearTimeout(timer)
        off()
        note("biometric_reply", { event: reply })
        resolve(d ?? {})
      })
      const timer = setTimeout(() => {
        off()
        note("biometric_timeout", { event, via: "events" })
        resolve(undefined)
      }, ms)
      post(win, event, data)
    })
  const byEvents = {
    async info() {
      return biometryInfo(
        await ask("web_app_biometry_get_info", {}, "biometry_info_received"),
      )
    },
    async requestAccess(reason) {
      return biometryInfo(
        await ask(
          "web_app_biometry_request_access",
          { reason },
          "biometry_info_received",
          authMs,
        ),
      )
    },
    /** The token Face ID releases, or undefined when it was refused. */
    async authenticate(reason) {
      const d = await ask(
        "web_app_biometry_request_auth",
        { reason },
        "biometry_auth_requested",
        authMs,
      )
      return d?.status === "authorized" &&
        typeof d.token === "string" &&
        d.token
        ? d.token
        : undefined
    },
    async saveToken(token) {
      const d = await ask(
        "web_app_biometry_update_token",
        { token },
        "biometry_token_updated",
      )
      return d?.status === "updated"
    },
  }
  // Each call picks at the time it is made, so a page that loads the script late still uses it.
  const pick = () => {
    const bm = manager()
    return bm ? viaManager(bm, { timeoutMs, authMs }) : byEvents
  }
  return {
    info: () => pick().info(),
    requestAccess: (reason) => pick().requestAccess(reason),
    authenticate: (reason) => pick().authenticate(reason),
    saveToken: (token) => pick().saveToken(token),
  }
}

/** Telegram's own biometric manager: the same four calls, each with a limit, none able to throw. */
function viaManager(bm, { timeoutMs, authMs }) {
  const call = (name, start, ms) =>
    new Promise((resolve) => {
      let settled = false
      const end = (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      }
      const timer = setTimeout(() => {
        note("biometric_timeout", { call: name, via: "sdk" })
        end(undefined)
      }, ms)
      try {
        start((...args) => end(args))
      } catch (err) {
        note("biometric_error", {
          call: name,
          error: String(err?.message ?? err).slice(0, 100),
        })
        end(undefined)
      }
    })
  const init = async () => {
    if (bm.isInited !== true)
      await call("init", (done) => bm.init(() => done()), timeoutMs)
  }
  const view = () => ({
    available: bm.isBiometricAvailable === true,
    type: bm.biometricType,
    accessGranted: bm.isAccessGranted === true,
    tokenSaved: bm.isBiometricTokenSaved === true,
  })
  return {
    async info() {
      await init()
      const i = view()
      note("biometric_info", {
        via: "sdk",
        inited: bm.isInited === true,
        available: i.available,
        type: i.type ?? "",
        granted: i.accessGranted,
        saved: i.tokenSaved,
      })
      return i
    },
    async requestAccess(reason) {
      await init()
      const r = await call(
        "access",
        (done) => bm.requestAccess({ reason }, (granted) => done(granted)),
        authMs,
      )
      const i = view()
      note("biometric_access", { granted: i.accessGranted || r?.[0] === true })
      return { ...i, accessGranted: i.accessGranted || r?.[0] === true }
    },
    async authenticate(reason) {
      await init()
      const r = await call(
        "auth",
        (done) => bm.authenticate({ reason }, (ok, token) => done(ok, token)),
        authMs,
      )
      const token = r?.[0] === true && typeof r[1] === "string" ? r[1] : ""
      note("biometric_auth", { ok: r?.[0] === true, token: token !== "" })
      return token || undefined
    },
    async saveToken(token) {
      await init()
      const r = await call(
        "token",
        (done) => bm.updateBiometricToken(token, (applied) => done(applied)),
        timeoutMs,
      )
      note("biometric_token", { applied: r?.[0] === true })
      return r?.[0] === true
    },
  }
}

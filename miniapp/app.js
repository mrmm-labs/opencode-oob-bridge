import { Api, Stream } from "./api.js"
import { createController } from "./controller.js"
import { createDevice } from "./factors.js"
import {
  applyTheme,
  chrome,
  followTheme,
  launch,
  note,
  onEvent,
  ready,
  setReporter,
} from "./tg.js"
import { isStale } from "./format.js"
import { render } from "./views.js"

const params = launch()
applyTheme(params.theme)
followTheme()
ready()

const api = new Api({ initData: params.initData })

// Telegram's own back, settings and confirm, where this client has them; the page draws its own where not.
const tg = chrome(window, params.version)
const ui = { nativeBack: tg.has("back"), nativeConfirm: tg.has("popup") }
tg.colors(params.theme)
tg.swipes(false)
tg.settings(true)

// A few short lines for the bridge's log, so a failure on a phone can be read afterwards. Never init data.
let reported = 0
setReporter((event, data) => {
  if (!params.initData || reported++ >= 40) return
  void api.log(event, data).catch(() => {})
})
// The server stamps every file URL with its build: this is the build the page was loaded from.
const build = new URL(import.meta.url).searchParams.get("v") ?? ""
note("boot", {
  ua: navigator.userAgent.slice(0, 150),
  ver: params.version,
  platform: params.platform,
  sdk: !!window.Telegram?.WebApp,
  bm: !!window.Telegram?.WebApp?.BiometricManager,
  iter:
    typeof ReadableStream !== "undefined" &&
    typeof ReadableStream.prototype[Symbol.asyncIterator] === "function",
  proxy: !!window.TelegramWebviewProxy,
  build,
})
const ctl = createController({
  api,
  build,
  start: params.start,
  device: createDevice(undefined, undefined, {
    version: params.version,
    platform: params.platform,
  }),
  makeStream: (h) => new Stream({ api, note, ...h }),
})

const root = document.getElementById("root")
let later = false

const typing = () => {
  const el = document.activeElement
  return (
    !!el && root.contains(el) && /^(input|textarea|select)$/i.test(el.tagName)
  )
}

/** Redraws, but never under a field the person is typing in: it waits for the blur. */
function draw() {
  if (typing()) {
    later = true
    return
  }
  later = false
  const keep = root.querySelector(".main")?.scrollTop ?? 0
  root.replaceChildren(render(ctl.state, ctl, Date.now(), ui))
  const main = root.querySelector(".main")
  if (main) main.scrollTop = keep
}

let said = false
ctl.subscribe((s) => {
  if (!said && s.meta) {
    said = true
    note("build", {
      page: build,
      app: s.meta.app ?? "",
      stale: isStale(build, s.meta.app),
    })
  }
})
ctl.subscribe(draw)

let backShown
let asked
ctl.subscribe((s) => {
  const back = s.phase === "ready" && s.route.name !== "list"
  if (back !== backShown) {
    backShown = back
    tg.back(back)
  }
  if (!s.confirm) asked = undefined
  else if (ui.nativeConfirm && s.confirm !== asked) {
    const c = (asked = s.confirm)
    tg.haptic("warning")
    void tg.confirm(c.text, { ok: "Yes", destructive: true }).then((ok) => {
      if (ctl.state.confirm !== c) return
      if (ok) void ctl.confirmed()
      else ctl.cancel()
    })
  }
})
onEvent((type, data) => {
  if (type === "theme_changed" && data?.theme_params)
    tg.colors(data.theme_params)
  if (type === "back_button_pressed") {
    if (ctl.state.confirm) ctl.cancel()
    else void ctl.go("list")
  }
  if (type === "settings_button_pressed") void ctl.go("info")
})
root.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("button"))
    tg.haptic("light")
})
root.addEventListener("focusout", () => setTimeout(() => later && draw(), 0))
setInterval(draw, 10_000)
let toastAt = 0
ctl.subscribe((s) => {
  if (s.toast && s.toast.at !== toastAt) {
    toastAt = s.toast.at
    tg.haptic(s.toast.ok ? "success" : "error")
    setTimeout(() => draw(), 4000)
  }
})
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ctl.state.phase === "ready") void ctl.refresh()
})

draw()
void ctl.boot()

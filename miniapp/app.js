import { Api, Stream } from "./api.js"
import { createController } from "./controller.js"
import { createDevice } from "./factors.js"
import { applyTheme, followTheme, launch, ready } from "./tg.js"
import { render } from "./views.js"

const params = launch()
applyTheme(params.theme)
followTheme()
ready()

const api = new Api({ initData: params.initData })
const ctl = createController({
  api,
  start: params.start,
  device: createDevice(),
  makeStream: (h) => new Stream({ api, ...h }),
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
  root.replaceChildren(render(ctl.state, ctl, Date.now()))
  const main = root.querySelector(".main")
  if (main) main.scrollTop = keep
}

ctl.subscribe(draw)
root.addEventListener("focusout", () => setTimeout(() => later && draw(), 0))
setInterval(draw, 10_000)
let toastAt = 0
ctl.subscribe((s) => {
  if (s.toast && s.toast.at !== toastAt) {
    toastAt = s.toast.at
    setTimeout(() => draw(), 4000)
  }
})
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ctl.state.phase === "ready") void ctl.refresh()
})

draw()
void ctl.boot()

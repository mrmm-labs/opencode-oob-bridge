import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  biometric,
  contrast,
  followTheme,
  launch,
  note,
  readable,
  setReporter,
  themeVars,
} from "./tg.js"

const loc = (hash, search = "") => ({ hash, search })

describe("launch parameters", () => {
  it("reads init data, theme and start parameter from the hash", () => {
    const init =
      "query_id=A&user=" + encodeURIComponent('{"id":1}') + "&hash=ab"
    const theme = JSON.stringify({ bg_color: "#112233" })
    const hash =
      "#tgWebAppData=" +
      encodeURIComponent(init) +
      "&tgWebAppThemeParams=" +
      encodeURIComponent(theme) +
      "&tgWebAppStartParam=ses_abc-1"
    const p = launch(loc(hash))
    assert.equal(p.initData, init)
    assert.deepEqual(p.theme, { bg_color: "#112233" })
    assert.equal(p.start, "ses_abc-1")
  })

  it("takes the session from ?s= when the hash has none, and refuses odd characters", () => {
    assert.equal(launch(loc("", "?s=ses_9")).start, "ses_9")
    assert.equal(launch(loc("#tgWebAppStartParam=a/b")).start, "")
    assert.equal(launch(loc("#tgWebAppStartParam=" + "x".repeat(65))).start, "")
  })

  it("reads the start parameter from the init data when the hash has none", () => {
    const init = encodeURIComponent(
      "user=%7B%7D&start_param=enrol_ABCD2345&hash=h",
    )
    assert.equal(launch(loc("#tgWebAppData=" + init)).start, "enrol_ABCD2345")
    assert.equal(
      launch(loc("#tgWebAppStartParam=s_a&tgWebAppData=" + init)).start,
      "s_a",
    )
  })

  it("reads the client version and platform for the diagnostics", () => {
    const p = launch(loc("#tgWebAppVersion=8.0&tgWebAppPlatform=ios"))
    assert.equal(p.version, "8.0")
    assert.equal(p.platform, "ios")
  })

  it("survives a missing or broken hash", () => {
    const p = launch(loc("#tgWebAppThemeParams=%7Bnot-json"))
    assert.deepEqual(p, {
      initData: "",
      theme: {},
      start: "",
      version: "",
      platform: "",
    })
    assert.equal(launch(loc("")).initData, "")
  })
})

describe("theme", () => {
  it("measures contrast like WCAG", () => {
    assert.equal(Math.round(contrast("#000000", "#ffffff")), 21)
    assert.equal(contrast("#777777", "nope"), undefined)
  })

  it("keeps a theme text colour that reads and replaces one that does not", () => {
    assert.equal(readable("#ffffff", "#000000"), "#ffffff")
    assert.equal(readable("#777777", "#808080", "#000000"), "#000000")
    assert.equal(readable("#777777", "#808080"), "#000000")
  })

  it("keeps every pair of the dark theme at 4.5:1", () => {
    const v = themeVars({
      bg_color: "#17212b",
      text_color: "#f5f5f5",
      hint_color: "#708499",
      link_color: "#6ab3f3",
      button_color: "#5288c1",
      button_text_color: "#ffffff",
      secondary_bg_color: "#232e3c",
      destructive_text_color: "#ec3942",
    })
    assert.equal(v["--scheme"], "dark")
    for (const [fg, bg] of [
      ["--text", "--bg"],
      ["--hint", "--bg2"],
      ["--link", "--bg"],
      ["--btn-text", "--btn"],
      ["--danger", "--bg2"],
    ])
      assert.ok(
        contrast(v[fg], v[bg]) >= 4.5,
        fg + " on " + bg + " " + contrast(v[fg], v[bg]),
      )
  })

  it("sets nothing for a theme it cannot read, so the stylesheet defaults stay", () => {
    assert.deepEqual(themeVars({}), {})
    assert.deepEqual(themeVars({ bg_color: "red", text_color: "blue" }), {})
  })
})

describe("biometric manager", () => {
  const fake = (replies) => {
    const win = {
      document: { documentElement: { style: { setProperty() {} } } },
      addEventListener() {},
      sent: [],
    }
    followTheme(win)
    win.TelegramWebviewProxy = {
      postEvent(type, data) {
        win.sent.push([type, JSON.parse(data)])
        const r = replies[type]
        if (r)
          queueMicrotask(() => win.Telegram.WebView.receiveEvent(r[0], r[1]))
      },
    }
    return win
  }

  it("reads what Telegram reports and sends the documented events", async () => {
    const win = fake({
      web_app_biometry_get_info: [
        "biometry_info_received",
        {
          available: true,
          type: "face",
          access_granted: true,
          token_saved: true,
        },
      ],
    })
    const info = await biometric(win).info()
    assert.deepEqual(info, {
      available: true,
      type: "face",
      accessGranted: true,
      tokenSaved: true,
    })
    assert.deepEqual(win.sent[0], ["web_app_biometry_get_info", {}])
  })

  it("returns the token only when Face ID authorised", async () => {
    const ok = fake({
      web_app_biometry_request_auth: [
        "biometry_auth_requested",
        { status: "authorized", token: "d.s" },
      ],
    })
    assert.equal(await biometric(ok).authenticate("why"), "d.s")
    assert.deepEqual(ok.sent[0], [
      "web_app_biometry_request_auth",
      { reason: "why" },
    ])
    const no = fake({
      web_app_biometry_request_auth: [
        "biometry_auth_requested",
        { status: "failed" },
      ],
    })
    assert.equal(await biometric(no).authenticate("why"), undefined)
  })

  it("saves a token and reports whether Telegram applied it", async () => {
    const win = fake({
      web_app_biometry_update_token: [
        "biometry_token_updated",
        { status: "updated" },
      ],
    })
    assert.equal(await biometric(win).saveToken("d.s"), true)
    assert.deepEqual(win.sent[0], [
      "web_app_biometry_update_token",
      { token: "d.s" },
    ])
  })

  it("reports not available when the client never answers", async () => {
    const win = fake({})
    const info = await biometric(win, { timeoutMs: 5 }).info()
    assert.equal(info.available, false)
    assert.equal(await biometric(win, { timeoutMs: 5 }).saveToken("x"), false)
  })
})

describe("the receive hooks", () => {
  const win = () => ({
    document: { documentElement: { style: { setProperty() {} } } },
    addEventListener() {},
  })

  it("defines every name a native client may call, and they reach the listeners", async () => {
    const w = win()
    followTheme(w)
    assert.equal(typeof w.Telegram.WebView.receiveEvent, "function")
    assert.equal(typeof w.TelegramGameProxy.receiveEvent, "function")
    assert.equal(typeof w.TelegramGameProxy_receiveEvent, "function")
    for (const call of [
      (type, d) => w.Telegram.WebView.receiveEvent(type, d),
      (type, d) => w.TelegramGameProxy.receiveEvent(type, d),
      (type, d) => w.TelegramGameProxy_receiveEvent(type, d),
    ]) {
      w.TelegramWebviewProxy = {
        postEvent: () =>
          queueMicrotask(() =>
            call("biometry_info_received", { available: true, type: "face" }),
          ),
      }
      assert.equal(
        (await biometric(w, { timeoutMs: 50 }).info()).available,
        true,
      )
    }
  })

  it("reads a reply whose data came as a JSON string", async () => {
    const w = win()
    followTheme(w)
    w.TelegramWebviewProxy = {
      postEvent: () =>
        queueMicrotask(() =>
          w.TelegramGameProxy.receiveEvent(
            "biometry_info_received",
            '{"available":true,"type":"face","token_saved":true}',
          ),
        ),
    }
    const info = await biometric(w, { timeoutMs: 50 }).info()
    assert.equal(info.available, true)
    assert.equal(info.tokenSaved, true)
  })

  it("leaves Telegram's own hooks in place when its script is there", () => {
    const own = () => {}
    const w = {
      ...win(),
      Telegram: { WebApp: { onEvent() {} }, WebView: { receiveEvent: own } },
    }
    followTheme(w)
    assert.equal(w.Telegram.WebView.receiveEvent, own)
  })
})

describe("biometric manager of Telegram's script", () => {
  const manager = (o = {}) => {
    const calls = []
    return {
      calls,
      isInited: false,
      isBiometricAvailable: true,
      biometricType: "face",
      isAccessGranted: false,
      isBiometricTokenSaved: false,
      init(cb) {
        calls.push("init")
        this.isInited = true
        queueMicrotask(cb)
      },
      requestAccess(p, cb) {
        calls.push(["access", p])
        this.isAccessGranted = true
        queueMicrotask(() => cb(true))
      },
      authenticate(p, cb) {
        calls.push(["auth", p])
        queueMicrotask(() => cb(true, "d.s"))
      },
      updateBiometricToken(t, cb) {
        calls.push(["token", t])
        queueMicrotask(() => cb(true))
      },
      ...o,
    }
  }
  const win = (bm) => ({ Telegram: { WebApp: { BiometricManager: bm } } })
  const lines = []
  setReporter((e, d) => lines.push([e, d]))

  it("reads the phone's state after init, and inits once", async () => {
    const bm = manager()
    const b = biometric(win(bm))
    const info = await b.info()
    assert.deepEqual(info, {
      available: true,
      type: "face",
      accessGranted: false,
      tokenSaved: false,
    })
    await b.info()
    assert.deepEqual(bm.calls, ["init"])
  })

  it("asks for access, authenticates and saves the token", async () => {
    const bm = manager()
    const b = biometric(win(bm))
    assert.equal((await b.requestAccess("why")).accessGranted, true)
    assert.equal(await b.authenticate("why"), "d.s")
    assert.equal(await b.saveToken("d.s"), true)
    assert.deepEqual(bm.calls.slice(1), [
      ["access", { reason: "why" }],
      ["auth", { reason: "why" }],
      ["token", "d.s"],
    ])
  })

  it("returns no token when authentication fails, and says not available when the manager says so", async () => {
    const bm = manager({
      isBiometricAvailable: false,
      authenticate: (p, cb) => queueMicrotask(() => cb(false)),
    })
    const b = biometric(win(bm))
    assert.equal((await b.info()).available, false)
    assert.equal(await b.authenticate("why"), undefined)
  })

  it("gives up after the limit when the manager never answers, and when it throws", async () => {
    const silent = manager({ init() {} })
    assert.equal(
      (await biometric(win(silent), { timeoutMs: 5 }).info()).available,
      true,
    )
    const never = manager({ isInited: true, updateBiometricToken() {} })
    assert.equal(
      await biometric(win(never), { timeoutMs: 5 }).saveToken("x"),
      false,
    )
    const bad = manager({
      isInited: true,
      authenticate() {
        throw new Error("WebAppBiometricManagerNotInited")
      },
    })
    assert.equal(await biometric(win(bad)).authenticate("why"), undefined)
  })

  it("reports each step to the bridge, never the token", async () => {
    lines.length = 0
    const b = biometric(win(manager()))
    await b.info()
    await b.authenticate("why")
    const names = lines.map(([e]) => e)
    assert.ok(names.includes("biometric_info"))
    assert.ok(names.includes("biometric_auth"))
    assert.ok(!JSON.stringify(lines).includes("d.s"))
  })

  it("keeps a failing reporter from breaking the call", () => {
    setReporter(() => {
      throw new Error("down")
    })
    note("x")
    setReporter((e, d) => lines.push([e, d]))
  })
})

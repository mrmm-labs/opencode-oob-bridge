import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { serviceClient } from "./serviceclient.ts"

const endpoint = { url: "http://127.0.0.1:1" }
const rig = (o: { found?: () => boolean; fail?: boolean } = {}) => {
  const clock = { t: 0 }
  const calls = { discover: 0, make: 0, reply: [] as unknown[] }
  const client = serviceClient({
    now: () => clock.t,
    ttlMs: 1000,
    discover: async () => {
      calls.discover++
      return (o.found?.() ?? true) ? endpoint : undefined
    },
    make: () => {
      calls.make++
      return {
        session: {
          form: {
            reply: async (i) => {
              if (o.fail) throw new Error("boom")
              calls.reply.push(i)
            },
          },
        },
      }
    },
  })
  return { client, clock, calls }
}

describe("the service client", () => {
  it("finds the service lazily, keeps it for the ttl, and replies through it", async () => {
    const r = rig()
    assert.equal(r.calls.discover, 0)
    assert.equal(await r.client.ready(), true)
    await r.client.reply({ sessionID: "s", formID: "f", answer: { q0: "Yes" } })
    assert.equal(r.calls.discover, 1, "found once")
    assert.deepEqual(r.calls.reply, [
      { sessionID: "s", formID: "f", answer: { q0: "Yes" } },
    ])
    r.clock.t += 1500
    assert.equal(await r.client.ready(), true)
    assert.equal(r.calls.discover, 2, "looked again after the ttl")
  })

  it("is not ready when no service answers, finds it later, and refuses a reply meanwhile", async () => {
    let up = false
    const r = rig({ found: () => up })
    assert.equal(await r.client.ready(), false)
    await assert.rejects(
      r.client.reply({ sessionID: "s", formID: "f", answer: {} }),
      /did not answer/,
    )
    up = true
    r.clock.t += 6000
    assert.equal(await r.client.ready(), true)
  })

  it("forgets the service after a failed reply, so the next call looks again", async () => {
    const r = rig({ fail: true })
    assert.equal(await r.client.ready(), true)
    await assert.rejects(
      r.client.reply({ sessionID: "s", formID: "f", answer: {} }),
      /boom/,
    )
    assert.equal(await r.client.ready(), true)
    assert.equal(r.calls.discover, 2)
  })

  it("is not ready when discovery throws", async () => {
    const c = serviceClient({
      discover: async () => {
        throw new Error("no module")
      },
    })
    assert.equal(await c.ready(), false)
  })
})

describe("the service client: the state of a request", () => {
  const tagged = (_tag: string) => Object.assign(new Error(_tag), { _tag })
  const make = (o: {
    form?: () => Promise<unknown>
    permission?: () => Promise<unknown>
  }) =>
    serviceClient({
      discover: async () => endpoint,
      make: () =>
        ({
          permission: { get: o.permission ?? (async () => ({})) },
          session: {
            form: { get: o.form ?? (async () => ({})), reply: async () => {} },
          },
        }) as never,
    })

  it("says a form it holds is open, and one it answered or cancelled is not", async () => {
    const open = make({ form: async () => ({ state: { status: "pending" } }) })
    assert.equal(await open.state("question", "s", "f"), "open")
    const done = make({ form: async () => ({ state: { status: "answered" } }) })
    assert.equal(await done.state("question", "s", "f"), "answered")
    const cut = make({ form: async () => ({ state: { status: "cancelled" } }) })
    assert.equal(await cut.state("question", "s", "f"), "cancelled")
  })

  it("counts a form or permission request it no longer has as answered", async () => {
    const c = make({
      form: async () => Promise.reject(tagged("FormNotFoundError")),
      permission: async () => Promise.reject(tagged("PermissionNotFoundError")),
    })
    assert.equal(await c.state("question", "s", "f"), "answered")
    assert.equal(await c.state("permission", "s", "p"), "answered")
  })

  it("says nothing on any other failure, or with no service", async () => {
    const c = make({
      form: async () => Promise.reject(tagged("SessionNotFoundError")),
      permission: async () => Promise.reject(new Error("socket hang up")),
    })
    assert.equal(await c.state("question", "s", "f"), undefined)
    assert.equal(await c.state("permission", "s", "p"), undefined)
    const none = serviceClient({ discover: async () => undefined })
    assert.equal(await none.state("question", "s", "f"), undefined)
  })

  it("says a permission request it holds is open", async () => {
    assert.equal(await make({}).state("permission", "s", "p"), "open")
  })
})

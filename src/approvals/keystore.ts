/**
 * Where the signing key and the TOTP seed live: the macOS Keychain, reached
 * through the Security framework from the host process (docs/approvals.md 7.3).
 * There is no file store and no `security` command: when the Keychain cannot be
 * used the service reports `unavailable`.
 */

export interface KeyStore {
  /** A read never raises a macOS prompt unless `prompt` is set (the `unlock` command, typed at the Mac). */
  get(name: string, o?: { prompt?: boolean }): Promise<string | undefined>
  /** Creates or replaces. Reachable only from the TUI. */
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

export class KeyStoreUnavailable extends Error {}

export class MemoryKeyStore implements KeyStore {
  readonly items = new Map<string, string>()
  async get(name: string) {
    return this.items.get(name)
  }
  async set(name: string, value: string) {
    this.items.set(name, value)
  }
  async delete(name: string) {
    this.items.delete(name)
  }
}

const SEC = "/System/Library/Frameworks/Security.framework/Security"
const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
const LIBC = "/usr/lib/libSystem.B.dylib"
const UTF8 = 0x08000100
const NOT_FOUND = -25300
const NO_UI = -25308
const RTLD_DEFAULT = 0xfffffffffffffffen

type Fn = (...a: unknown[]) => never
type Lib = { symbols: Record<string, Fn> }
type Ffi = {
  dlopen(path: string, symbols: Record<string, unknown>): Lib
  ptr(b: ArrayBufferView): number
  read: { u64(p: number): bigint | number }
  toArrayBuffer(p: number, offset: number, length: number): ArrayBuffer
}

/**
 * Items are generic passwords whose access list names the host executable
 * only, so another process makes macOS ask before it reads. Pointers are
 * passed as u64: a CoreFoundation small string is a tagged pointer above 2^53.
 */
export class KeychainStore implements KeyStore {
  private readonly service: string
  private readonly load: () => Promise<Ffi>
  private api: Promise<Api> | undefined

  constructor(
    service = "opencode-oob-bridge.approvals",
    load?: () => Promise<Ffi>,
  ) {
    this.service = service
    this.load =
      load ??
      (async () => {
        if (process.platform !== "darwin")
          throw new KeyStoreUnavailable("the Keychain exists on macOS only")
        const name = "bun:ffi"
        try {
          return (await import(name)) as Ffi
        } catch {
          throw new KeyStoreUnavailable("this runtime has no bun:ffi")
        }
      })
  }

  private open(): Promise<Api> {
    this.api ??= this.load().then(makeApi)
    this.api.catch(() => (this.api = undefined))
    return this.api
  }

  async get(
    name: string,
    o?: { prompt?: boolean },
  ): Promise<string | undefined> {
    return (await this.open()).read(this.service, name, o?.prompt === true)
  }

  async set(name: string, value: string): Promise<void> {
    await (await this.open()).write(this.service, name, value)
  }

  async delete(name: string): Promise<void> {
    await (await this.open()).remove(this.service, name)
  }
}

type Api = {
  read(service: string, account: string, prompt: boolean): string | undefined
  write(service: string, account: string, value: string): void
  remove(service: string, account: string): void
}

function makeApi(ffi: Ffi): Api {
  const { dlopen, ptr, read, toArrayBuffer } = ffi
  const u = (v: unknown) => v as bigint
  const libc = dlopen(LIBC, { dlsym: { args: ["u64", "ptr"], returns: "u64" } })
  const cf = dlopen(CF, {
    CFStringCreateWithCString: { args: ["u64", "u64", "u32"], returns: "u64" },
    CFDataCreate: { args: ["u64", "u64", "i64"], returns: "u64" },
    CFDictionaryCreate: {
      args: ["u64", "u64", "u64", "i64", "u64", "u64"],
      returns: "u64",
    },
    CFArrayCreate: { args: ["u64", "u64", "i64", "u64"], returns: "u64" },
    CFDataGetBytePtr: { args: ["u64"], returns: "u64" },
    CFDataGetLength: { args: ["u64"], returns: "i64" },
    CFRelease: { args: ["u64"], returns: "void" },
  })
  const sec = dlopen(SEC, {
    SecItemAdd: { args: ["u64", "u64"], returns: "i32" },
    SecItemCopyMatching: { args: ["u64", "u64"], returns: "i32" },
    SecItemDelete: { args: ["u64"], returns: "i32" },
    SecAccessCreate: { args: ["u64", "u64", "u64"], returns: "i32" },
    SecTrustedApplicationCreateFromPath: {
      args: ["u64", "u64"],
      returns: "i32",
    },
  })
  const names: Buffer[] = []
  const symbol = (name: string): bigint => {
    const b = Buffer.from(name + "\0")
    names.push(b)
    return u(libc.symbols.dlsym(RTLD_DEFAULT, b))
  }
  const valueOf = (name: string): bigint =>
    BigInt(read.u64(Number(symbol(name))))
  const P = (b: ArrayBufferView) => BigInt(ptr(b))
  const fail = (what: string, rc: number): never => {
    throw new KeyStoreUnavailable(`Keychain ${what} failed (${rc})`)
  }

  /** One operation's allocations: kept alive while it runs, released after. */
  const scope = () => {
    const keep: unknown[] = []
    const owned: bigint[] = []
    const own = (v: bigint) => (owned.push(v), v)
    const str = (t: string) => {
      const b = Buffer.from(t + "\0")
      keep.push(b)
      return own(u(cf.symbols.CFStringCreateWithCString(0n, P(b), UTF8)))
    }
    const dict = (pairs: Array<[bigint, bigint]>) => {
      const keys = new BigUint64Array(pairs.map(([k]) => k))
      const vals = new BigUint64Array(pairs.map(([, v]) => v))
      keep.push(keys, vals)
      return own(
        u(
          cf.symbols.CFDictionaryCreate(
            0n,
            P(keys),
            P(vals),
            pairs.length,
            symbol("kCFTypeDictionaryKeyCallBacks"),
            symbol("kCFTypeDictionaryValueCallBacks"),
          ),
        ),
      )
    }
    const cell = () => {
      const b = new BigUint64Array(1)
      keep.push(b)
      return b
    }
    const done = () => {
      for (const v of owned) if (v) cf.symbols.CFRelease(v)
    }
    return { keep, own, str, dict, cell, done }
  }

  const query = (
    s: ReturnType<typeof scope>,
    service: string,
    account: string,
  ) =>
    [
      [s.str("class"), s.str("genp")],
      [s.str("svce"), s.str(service)],
      [s.str("acct"), s.str(account)],
    ] as Array<[bigint, bigint]>

  return {
    read(service, account, prompt) {
      const s = scope()
      try {
        const res = s.cell()
        const rc = sec.symbols.SecItemCopyMatching(
          s.dict([
            ...query(s, service, account),
            [s.str("r_Data"), valueOf("kCFBooleanTrue")],
            [s.str("m_Limit"), s.str("m_LimitOne")],
            // A prompt would block the whole server until someone answers at the Mac.
            ...(prompt
              ? []
              : ([[s.str("u_AuthUI"), s.str("u_AuthUIF")]] as Array<
                  [bigint, bigint]
                >)),
          ]),
          P(res),
        ) as unknown as number
        if (rc === NOT_FOUND) return undefined
        if (rc === NO_UI)
          throw new KeyStoreUnavailable(
            "the Keychain wants an answer at the Mac: run /oob approvals unlock",
          )
        if (rc !== 0) return fail("read", rc)
        s.own(res[0])
        const len = Number(cf.symbols.CFDataGetLength(res[0]) as never)
        const at = Number(cf.symbols.CFDataGetBytePtr(res[0]) as never)
        return Buffer.from(toArrayBuffer(at, 0, len)).toString("utf8")
      } finally {
        s.done()
      }
    },
    write(service, account, value) {
      const s = scope()
      try {
        const app = s.cell()
        let rc = sec.symbols.SecTrustedApplicationCreateFromPath(
          0n,
          P(app),
        ) as unknown as number
        if (rc !== 0) fail("trusted application", rc)
        s.own(app[0])
        const arr = new BigUint64Array([app[0]])
        s.keep.push(arr)
        const list = s.own(
          u(
            cf.symbols.CFArrayCreate(
              0n,
              P(arr),
              1,
              symbol("kCFTypeArrayCallBacks"),
            ),
          ),
        )
        const access = s.cell()
        rc = sec.symbols.SecAccessCreate(
          s.str("opencode-oob-bridge approvals"),
          list,
          P(access),
        ) as unknown as number
        if (rc !== 0) fail("access rule", rc)
        s.own(access[0])
        const secret = Buffer.from(value)
        s.keep.push(secret)
        const data = s.own(
          u(cf.symbols.CFDataCreate(0n, P(secret), secret.length)),
        )
        const base = query(s, service, account)
        rc = sec.symbols.SecItemDelete(s.dict(base)) as unknown as number
        if (rc !== 0 && rc !== NOT_FOUND) fail("replace", rc)
        rc = sec.symbols.SecItemAdd(
          s.dict([
            ...base,
            [s.str("v_Data"), data],
            [s.str("sacc"), access[0]],
          ]),
          0n,
        ) as unknown as number
        if (rc !== 0) fail("write", rc)
      } finally {
        s.done()
      }
    },
    remove(service, account) {
      const s = scope()
      try {
        const rc = sec.symbols.SecItemDelete(
          s.dict(query(s, service, account)),
        ) as unknown as number
        if (rc !== 0 && rc !== NOT_FOUND) fail("delete", rc)
      } finally {
        s.done()
      }
    },
  }
}

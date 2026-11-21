import { dlopen, ptr, read, toArrayBuffer } from "bun:ffi"

const SEC = "/System/Library/Frameworks/Security.framework/Security"
const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"

export function spike(service, account, secretText) {
  const out = { steps: [] }
  const step = (name, v) => out.steps.push([name, v])
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    dlsym: { args: ["u64", "ptr"], returns: "u64" },
  })
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
  const names = []
  const addr = (name) => {
    const b = Buffer.from(name + "\0")
    names.push(b)
    return libc.symbols.dlsym(0xfffffffffffffffen, b)
  }
  const valueOf = (name) => BigInt(read.u64(Number(addr(name))))
  const P = (b) => BigInt(ptr(b))
  const bufs = []
  const s = (t) => {
    const b = Buffer.from(t + "\0")
    bufs.push(b)
    return cf.symbols.CFStringCreateWithCString(0n, P(b), 0x08000100)
  }
  const dict = (pairs) => {
    const keys = new BigUint64Array(pairs.length)
    const vals = new BigUint64Array(pairs.length)
    pairs.forEach(([k, v], i) => {
      keys[i] = k
      vals[i] = v
    })
    bufs.push(keys, vals)
    return cf.symbols.CFDictionaryCreate(
      0n,
      P(keys),
      P(vals),
      pairs.length,
      addr("kCFTypeDictionaryKeyCallBacks"),
      addr("kCFTypeDictionaryValueCallBacks"),
    )
  }
  const cell = () => {
    const b = new BigUint64Array(1)
    bufs.push(b)
    return b
  }

  const app = cell()
  step(
    "SecTrustedApplicationCreateFromPath(NULL)",
    sec.symbols.SecTrustedApplicationCreateFromPath(0n, P(app)),
  )
  const arr = new BigUint64Array([app[0]])
  bufs.push(arr)
  const list = cf.symbols.CFArrayCreate(
    0n,
    P(arr),
    1,
    addr("kCFTypeArrayCallBacks"),
  )
  const access = cell()
  step(
    "SecAccessCreate",
    sec.symbols.SecAccessCreate(s("oob-bridge spike"), list, P(access)),
  )

  const kClass = s("class"),
    kGenp = s("genp"),
    kSvc = s("svce"),
    kAcct = s("acct")
  const kData = s("v_Data"),
    kAccess = s("sacc"),
    kRet = s("r_Data"),
    kLim = s("m_Limit"),
    kOne = s("m_LimitOne")
  const secret = Buffer.from(secretText)
  bufs.push(secret)
  const dat = cf.symbols.CFDataCreate(0n, P(secret), secret.length)
  const base = [
    [kClass, kGenp],
    [kSvc, s(service)],
    [kAcct, s(account)],
  ]
  step("SecItemDelete(pre)", sec.symbols.SecItemDelete(dict(base)))
  step(
    "SecItemAdd",
    sec.symbols.SecItemAdd(
      dict([...base, [kData, dat], [kAccess, access[0]]]),
      0n,
    ),
  )
  const res = cell()
  const rc = sec.symbols.SecItemCopyMatching(
    dict([...base, [kRet, valueOf("kCFBooleanTrue")], [kLim, kOne]]),
    P(res),
  )
  step("SecItemCopyMatching", rc)
  if (rc === 0) {
    const len = Number(cf.symbols.CFDataGetLength(res[0]))
    const bytes = Number(cf.symbols.CFDataGetBytePtr(res[0]))
    out.readBack = Buffer.from(toArrayBuffer(bytes, 0, len)).toString()
  }
  out.exec = process.execPath
  out.bun = process.versions.bun
  out.cleanup = () => sec.symbols.SecItemDelete(dict(base))
  return out
}

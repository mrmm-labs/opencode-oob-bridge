import { promisify } from "node:util"
import { inflate } from "node:zlib"

const inflateAsync = promisify(inflate)

/** Reads back what encodePng writes: 8-bit indexed, filter 0. Throws on a bad signature or checksum. */
export async function decodePng(png: Uint8Array) {
  const b = Buffer.from(png)
  if (b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("not a PNG")
  let width = 0
  let height = 0
  let palette: number[][] = []
  const idat: Buffer[] = []
  for (let at = 8; at < b.length; ) {
    const len = b.readUInt32BE(at)
    const type = b.toString("latin1", at + 4, at + 8)
    const data = b.subarray(at + 8, at + 8 + len)
    const want = b.readUInt32BE(at + 8 + len)
    if (zlibCrc(b.subarray(at + 4, at + 8 + len)) !== want)
      throw new Error("bad CRC in " + type)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 3) throw new Error("not 8-bit indexed")
    } else if (type === "PLTE")
      for (let i = 0; i < len; i += 3)
        palette.push([...data.subarray(i, i + 3)])
    else if (type === "IDAT") idat.push(data)
    at += 12 + len
  }
  const raw = await inflateAsync(Buffer.concat(idat))
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    if (raw[y * (width + 1)] !== 0) throw new Error("unexpected filter")
    pixels.set(
      raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)),
      y * width,
    )
  }
  return { width, height, palette, pixels }
}

import { crc32 as zlibCrc } from "node:zlib"
